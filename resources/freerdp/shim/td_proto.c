#include "td_proto.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <winpr/synch.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define td_dup _dup
#define td_dup2 _dup2
#else
#include <unistd.h>
#define td_dup dup
#define td_dup2 dup2
#endif

/* The real pipe, after td_proto_init has moved it out of everyone's reach. */
static FILE* out_pipe = NULL;

/**
 * One record at a time, whichever thread is writing it.
 *
 * FreeRDP's dynamic virtual channels run on a thread of their own, and the
 * graphics pipeline rides on them — so a decoded frame is written from that
 * thread while a pointer update or an event is written from the main one. Two
 * unguarded writers interleave a header into the middle of somebody's pixels,
 * and everything after it is misaligned: the picture comes back with a band of
 * torn rows near the top and the rest shifted sideways, which is exactly how
 * this was found.
 */
static CRITICAL_SECTION writing;

int td_proto_init(void)
{
	const int moved = td_dup(1);
	if (moved < 0)
		return 0;

#ifdef _WIN32
	/* Otherwise every 0x0A byte in a frame is written as CR LF, and a picture
	 * arrives longer than its own length says it is. */
	_setmode(moved, _O_BINARY);
#endif

	/* Descriptor 1 now goes where the logs go. Nothing is lost: a library that
	 * writes to stdout still writes, and what it writes is still read — by
	 * whoever is reading this process's log, which is where it was useful. */
	if (td_dup2(2, 1) < 0)
		return 0;

	out_pipe = fdopen(moved, "wb");
	if (!out_pipe)
		return 0;

	InitializeCriticalSection(&writing);

	/* No buffering of our own: every record is flushed the moment it is
	 * whole, and a second layer of buffer under that only adds a copy. */
	setvbuf(out_pipe, NULL, _IONBF, 0);
	return 1;
}

/* ------------------------------------------------------------------ reading */

/**
 * One line, however long, without a fixed buffer.
 *
 * A password or a certificate has no length this side gets to decide, and a
 * line reader with a limit turns a long one into a truncated one — which here
 * would mean an authentication failure nobody could explain.
 *
 * Returns NULL at end of input. The trailing newline is not kept.
 */
static char* read_line(void)
{
	size_t size = 128;
	size_t used = 0;
	char* buffer = malloc(size);
	if (!buffer)
		return NULL;

	for (;;)
	{
		const int c = fgetc(stdin);
		if (c == EOF)
		{
			if (used == 0)
			{
				free(buffer);
				return NULL;
			}
			break;
		}
		if (c == '\n')
			break;

		if (used + 1 >= size)
		{
			size *= 2;
			char* grown = realloc(buffer, size);
			if (!grown)
			{
				free(buffer);
				return NULL;
			}
			buffer = grown;
		}
		buffer[used++] = (char)c;
	}

	buffer[used] = '\0';
	return buffer;
}

/**
 * Undoes the three escapes the driving side applies, in place.
 *
 * Only three exist, and only three can: a value is ended by a newline and
 * separated from its key by a tab, so those two and the backslash that escapes
 * them are the whole alphabet. Anything else after a backslash is left as it
 * was written rather than swallowed, so a Windows path typed into a field
 * survives even if the far side forgot to escape it.
 */
static void unescape(char* text)
{
	char* out = text;
	for (const char* in = text; *in; in++)
	{
		if (*in != '\\')
		{
			*out++ = *in;
			continue;
		}
		switch (in[1])
		{
			case 'n':
				*out++ = '\n';
				in++;
				break;
			case 't':
				*out++ = '\t';
				in++;
				break;
			case '\\':
				*out++ = '\\';
				in++;
				break;
			default:
				*out++ = '\\';
				break;
		}
	}
	*out = '\0';
}

td_cmd* td_cmd_read(void)
{
	td_cmd* cmd = calloc(1, sizeof(td_cmd));
	if (!cmd)
		return NULL;

	for (;;)
	{
		char* line = read_line();
		if (!line)
		{
			/* The pipe closed. A half-read message is not a message. */
			td_cmd_free(cmd);
			return NULL;
		}
		if (line[0] == '\0')
		{
			free(line);
			/* A blank line before any field is a keep-alive, not a message. */
			if (cmd->count == 0)
				continue;
			return cmd;
		}

		char* tab = strchr(line, '\t');
		if (!tab || cmd->count >= TD_MAX_FIELDS)
		{
			/* Malformed, or more fields than any message of ours has. Dropped
			 * rather than guessed at; the message it belongs to will be
			 * incomplete and refused by whoever reads it. */
			free(line);
			continue;
		}

		*tab = '\0';
		char* key = strdup(line);
		char* value = strdup(tab + 1);
		free(line);
		if (!key || !value)
		{
			free(key);
			free(value);
			continue;
		}
		unescape(value);
		cmd->fields[cmd->count].key = key;
		cmd->fields[cmd->count].value = value;
		cmd->count++;
	}
}

void td_cmd_free(td_cmd* cmd)
{
	if (!cmd)
		return;
	for (size_t i = 0; i < cmd->count; i++)
	{
		free(cmd->fields[i].key);
		free(cmd->fields[i].value);
	}
	free(cmd);
}

const char* td_cmd_str(const td_cmd* cmd, const char* key, const char* fallback)
{
	if (!cmd)
		return fallback;
	for (size_t i = 0; i < cmd->count; i++)
	{
		if (strcmp(cmd->fields[i].key, key) == 0)
			return cmd->fields[i].value;
	}
	return fallback;
}

int td_cmd_int(const td_cmd* cmd, const char* key, int fallback)
{
	const char* text = td_cmd_str(cmd, key, NULL);
	if (!text || !*text)
		return fallback;
	return (int)strtol(text, NULL, 10);
}

int td_cmd_bool(const td_cmd* cmd, const char* key, int fallback)
{
	const char* text = td_cmd_str(cmd, key, NULL);
	if (!text || !*text)
		return fallback;
	return strcmp(text, "1") == 0 || strcmp(text, "true") == 0;
}

/* ------------------------------------------------------------------ writing */

int td_write_record(uint8_t type, const void* payload, size_t length)
{
	uint8_t header[5];
	header[0] = type;
	/* Little-endian, stated rather than assumed: this is read by
	 * Buffer.readUInt32LE on the other side, and both ends being
	 * little-endian machines today is not a reason to leave it implied. */
	header[1] = (uint8_t)(length & 0xFF);
	header[2] = (uint8_t)((length >> 8) & 0xFF);
	header[3] = (uint8_t)((length >> 16) & 0xFF);
	header[4] = (uint8_t)((length >> 24) & 0xFF);

	if (!out_pipe)
		return 0;

	EnterCriticalSection(&writing);
	int ok = fwrite(header, 1, sizeof(header), out_pipe) == sizeof(header);
	if (ok && length > 0)
		ok = fwrite(payload, 1, length, out_pipe) == length;
	/* Flushed every time, and inside the lock. A frame held back for a fuller
	 * buffer is latency that shows on screen; a flush outside the lock would
	 * let the next record's header overtake this one's payload. */
	if (ok)
		ok = fflush(out_pipe) == 0;
	LeaveCriticalSection(&writing);
	return ok;
}

const char* td_json_escape(char* out, size_t size, const char* in)
{
	size_t used = 0;
	if (size == 0)
		return out;

	for (const char* p = in ? in : ""; *p; p++)
	{
		const unsigned char c = (unsigned char)*p;
		char piece[8];
		size_t width;

		if (c == '"' || c == '\\')
		{
			piece[0] = '\\';
			piece[1] = (char)c;
			width = 2;
		}
		else if (c < 0x20)
		{
			/* Control characters have no literal form in JSON. \u escapes are
			 * the only spelling every parser accepts. */
			width = (size_t)snprintf(piece, sizeof(piece), "\\u%04x", c);
		}
		else
		{
			piece[0] = (char)c;
			width = 1;
		}

		/* Stop on a whole character rather than half an escape: a record cut
		 * mid-escape is one the far side cannot parse at all, which loses the
		 * message instead of its tail. */
		if (used + width + 1 > size)
			break;
		memcpy(out + used, piece, width);
		used += width;
	}

	out[used] = '\0';
	return out;
}

int td_event(const char* format, ...)
{
	/* Measured, then allocated. Most events are a line, but the one carrying a
	 * certificate carries a whole PEM chain — and an event truncated to fit a
	 * fixed buffer is invalid JSON, which loses the message rather than its
	 * tail. */
	va_list args;
	va_start(args, format);
	va_list again;
	va_copy(again, args);
	const int written = vsnprintf(NULL, 0, format, args);
	va_end(args);

	if (written < 0)
	{
		va_end(again);
		return 0;
	}

	char* text = malloc((size_t)written + 1u);
	if (!text)
	{
		va_end(again);
		return 0;
	}
	(void)vsnprintf(text, (size_t)written + 1u, format, again);
	va_end(again);

	const int ok = td_write_record(TD_REC_EVENT, text, (size_t)written);
	free(text);
	return ok;
}
