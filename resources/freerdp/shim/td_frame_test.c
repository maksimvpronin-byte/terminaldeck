/* Exercise the actual frame and command code without a server or a pipe. */
#define main td_client_main
#define td_write_record capture_record
#include "td_rdp.c"
#undef td_write_record
#undef main
#include <assert.h>

static int frames;
static size_t last_length;
static unsigned char last_pixels[64];
int capture_record(uint8_t type, const void* payload, size_t length)
{
	assert(type == TD_REC_FRAME);
	assert(length <= sizeof(last_pixels));
	frames++;
	last_length = length;
	memcpy(last_pixels, payload, length);
	return 1;
}

static void visibility(tdContext* td, char* value)
{
	td_cmd cmd = { 0 };
	cmd.fields[0] = (td_field){ "a", "visible" };
	cmd.fields[1] = (td_field){ "value", value };
	cmd.count = 2;
	apply_command(td, &cmd);
}

int main(void)
{
	tdContext td = { 0 };
	rdpGdi gdi = { 0 };
	BYTE pixels[16] = { 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0 };
	gdi.width = gdi.height = 2;
	gdi.stride = 8;
	gdi.primary_buffer = pixels;
	td.common.context.gdi = &gdi;
	InitializeCriticalSection(&td.paint);

	note_damage(&td, 0, 0, 1, 1);
	flush_frame(&td);
	assert(frames == 1 && td.inflight);
	visibility(&td, "0");
	pixels[0] = 42;
	note_damage(&td, 0, 0, 1, 1);
	paint_taken(&td); /* The last visible frame arrives after hiding. */
	assert(frames == 1 && !td.inflight);
	visibility(&td, "1");
	assert(frames == 2 && td.inflight && last_length == 24);
	assert(last_pixels[8] == 42 && last_pixels[11] == 255);

	/* Resume before the old frame's ack: no second frame until that ack. */
	visibility(&td, "0");
	visibility(&td, "1");
	assert(frames == 2);
	paint_taken(&td);
	assert(frames == 3 && last_length == 24);
	paint_taken(&td);
	assert(frames == 3); /* No redundant repaint when nothing changed. */

	/* Resizing a hidden desktop stays quiet, then restores the entire screen. */
	visibility(&td, "0");
	paint_all(&td, 2, 2);
	assert(frames == 3);
	visibility(&td, "1");
	assert(frames == 4 && last_length == 24);

	free(td.scratch);
	DeleteCriticalSection(&td.paint);
	return 0;
}
