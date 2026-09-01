/*
 * How TerminalDeck and this client talk to each other.
 *
 * Two directions, two formats, each chosen for the side that has to do the
 * hard half in C:
 *
 *   In  — tab-separated `key<TAB>value` lines, one field per line, a blank
 *         line ending the message. Parsing this in C is thirty lines; parsing
 *         JSON is not, and a hand-rolled JSON parser handling a password with
 *         a quote in it is exactly the kind of code that fails once, in the
 *         field, for one person.
 *   Out — length-prefixed binary records. Frames are pixels and cannot travel
 *         as text at all; events are JSON, because *writing* JSON in C is a
 *         printf and Node already reads it.
 *
 * Both ends are ours, so there is no negotiation and no version byte: the
 * binary is built from this tree and shipped with the application that drives
 * it.
 */
#ifndef TD_PROTO_H
#define TD_PROTO_H

#include <stddef.h>
#include <stdint.h>

/* Record types, the first byte of every record this process writes. */
#define TD_REC_EVENT 1  /* UTF-8 JSON, one object */
#define TD_REC_FRAME 2  /* u16 x, y, w, h, then w*h pixels, RGBA, top row first */
#define TD_REC_CURSOR 3 /* u16 w, h, hotX, hotY, then w*h pixels, RGBA */
#define TD_REC_CURSOR_STATE 4 /* u8: 0 hidden, 1 the system's own arrow */

/* A message read from the driving process: a flat bag of fields. */
#define TD_MAX_FIELDS 32

typedef struct
{
	char* key;
	char* value;
} td_field;

typedef struct td_cmd
{
	td_field fields[TD_MAX_FIELDS];
	size_t count;
	struct td_cmd* next;
} td_cmd;

/**
 * Reads one message from standard input, blocking until it is whole.
 *
 * Returns NULL at end of input, which is how this process is told to stop:
 * the pipe closing is the one signal that arrives even when the far side died
 * without saying anything.
 */
td_cmd* td_cmd_read(void);

void td_cmd_free(td_cmd* cmd);

/** A field's value, or `fallback` when the message did not carry it. */
const char* td_cmd_str(const td_cmd* cmd, const char* key, const char* fallback);
int td_cmd_int(const td_cmd* cmd, const char* key, int fallback);
int td_cmd_bool(const td_cmd* cmd, const char* key, int fallback);

/**
 * Takes the output pipe away from everything else in the process.
 *
 * Records are binary, and a single stray line on the same descriptor desyncs
 * the stream for good — the far side reads a length out of the middle of a
 * word and waits forever for bytes that will never come. FreeRDP logs, the
 * libraries under it log, and one `printf` left in by anybody would do it.
 *
 * So the real standard output is duplicated to a descriptor only this file
 * knows, and descriptor 1 is pointed at standard error. After this, anything
 * written to stdout by any code in this process lands in the log where it
 * belongs, and cannot reach the pipe at all.
 *
 * Returns 0 if the descriptors could not be arranged, in which case nothing
 * should be written.
 */
int td_proto_init(void);

/**
 * Writes one record, whole or not at all.
 *
 * Every write goes through here and every write is followed by a flush,
 * because a frame sitting in a buffer is a picture that never arrives. A
 * failure means the far side has gone: the caller stops rather than retries.
 */
int td_write_record(uint8_t type, const void* payload, size_t length);

/**
 * An event, formatted as a JSON object.
 *
 * `format` is printf's, and the caller writes the braces. Strings that came
 * from the network — a certificate's subject, a server's error — must go
 * through `td_json_escape` first.
 */
int td_event(const char* format, ...);

/**
 * One string, escaped for JSON, into a caller-owned buffer.
 *
 * Returns `out`, always, so it composes inside a printf argument list. What
 * does not fit is dropped rather than truncated mid-escape, which would
 * produce a record Node cannot parse.
 */
const char* td_json_escape(char* out, size_t size, const char* in);

#endif
