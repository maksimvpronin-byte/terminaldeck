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

static unsigned layouts;
static UINT32 layout_width, layout_height;
static UINT send_layout(DispClientContext* disp, UINT32 count, DISPLAY_CONTROL_MONITOR_LAYOUT* monitors)
{
	(void)disp;
	assert(count == 1);
	layouts++;
	layout_width = monitors[0].Width;
	layout_height = monitors[0].Height;
	return CHANNEL_RC_OK;
}
static void resize(tdContext* td, char* width, char* height)
{
	td_cmd cmd = { 0 };
	cmd.fields[0] = (td_field){ "a", "resize" };
	cmd.fields[1] = (td_field){ "width", width };
	cmd.fields[2] = (td_field){ "height", height };
	cmd.count = 3;
	apply_command(td, &cmd);
}

/*
 * A pane resized in the second or two before the server opens Display Control
 * had its size dropped: nothing could be sent yet, and when the channel did
 * open nothing was sent then either — a repeat of the same size looked like a
 * size already asked for. The desktop kept the size it connected at.
 */
static void early_resize(void)
{
	tdContext td = { 0 };
	DispClientContext disp = { 0 };
	disp.custom = &td;
	disp.SendMonitorLayout = send_layout;
	td.disp = &disp;
	td.want_width = td.sent_width = 1280;
	td.want_height = td.sent_height = 800;

	resize(&td, "1600", "900");
	assert(layouts == 0);
	resize(&td, "1600", "900");
	assert(layouts == 0);

	assert(td_display_caps(&disp, 1, 0, 0) == CHANNEL_RC_OK);
	assert(layouts == 1 && layout_width == 1600 && layout_height == 900);

	/* Once sent, the same size again is not sent again. */
	resize(&td, "1600", "900");
	assert(layouts == 1);
	resize(&td, "1280", "800");
	assert(layouts == 2 && layout_width == 1280);

	/* A channel that opens with the size already right sends nothing. */
	td.disp_ready = 0;
	assert(td_display_caps(&disp, 1, 0, 0) == CHANNEL_RC_OK);
	assert(layouts == 2);
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

	early_resize();

	free(td.scratch);
	DeleteCriticalSection(&td.paint);
	return 0;
}
