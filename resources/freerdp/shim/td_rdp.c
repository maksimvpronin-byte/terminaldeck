/*
 * td-rdp — the desktop client TerminalDeck drives, in a process of its own.
 *
 * FreeRDP does everything that is hard: TLS, the gateway, NLA, and above all
 * the graphics pipeline — H.264, RemoteFX progressive, and the legacy bitmap
 * codecs — decoding whichever the server chose into one plain framebuffer.
 * This file is the thin part around it: it takes instructions on stdin, hands
 * back the pixels that changed on stdout, and forwards input the other way.
 *
 * Out of process on purpose. The precedent is ShadowHost.exe, already shipped
 * and driven the same way, and the reason is the same: a decoder fault ends a
 * pane rather than the window, and nothing here is tied to Electron's ABI.
 *
 * What this file deliberately does not do: re-encode. The renderer is handed
 * the very bytes the decoder produced, in the byte order a canvas wants, so
 * the only copies between the wire and the screen are the ones that move the
 * changed rectangle along.
 */

#include <freerdp/config.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <freerdp/freerdp.h>
#include <freerdp/constants.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/graphics.h>
#include <freerdp/settings.h>
#include <freerdp/input.h>
#include <freerdp/codec/color.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/disp.h>
#include <freerdp/channels/rdpsnd.h>

#include <winpr/crt.h>
#include <winpr/synch.h>
#include <winpr/thread.h>

#include "td_proto.h"

/* ------------------------------------------------------------------- state */

/** A pointer image, kept converted so `Set` is only a write to the pipe. */
typedef struct
{
	rdpPointer pointer;
	BYTE* pixels;
} tdPointer;

typedef struct
{
	rdpClientContext common; /* must be first: FreeRDP allocates and casts */

	/* Commands arriving from the driving process. */
	HANDLE arrived;   /* set when the queue is not empty */
	CRITICAL_SECTION lock;
	td_cmd* queue;
	td_cmd* queue_tail;

	/* The certificate answer, which is asked for mid-connect and waited on. */
	HANDLE answered;
	int trusted;

	/**
	 * The rectangle that has changed and not yet been sent, as a union.
	 *
	 * A union of rectangles rather than a list of them: two changed corners of
	 * a screen are cheaper to send as one span than they are to track, and the
	 * case that actually costs bandwidth — video — dirties everything anyway.
	 */
	int dirty;
	UINT32 dx1, dy1, dx2, dy2;

	/**
	 * Whether a frame is out and unacknowledged.
	 *
	 * This is the whole flow-control scheme, and it is deliberately the
	 * simplest one that cannot fall behind: at most one frame is in flight,
	 * and everything that changes while it is travelling accumulates into the
	 * rectangle above. A slow renderer therefore lowers the frame rate, which
	 * is what should happen, instead of growing a queue that ends as latency
	 * or as memory.
	 */
	int inflight;

	BYTE* scratch; /* the rectangle being sent, made contiguous */
	size_t scratch_size;

	DispClientContext* disp;
	int disp_ready;

	/** The size last asked of the server, so a repeat can be ignored. */
	UINT32 want_width, want_height, want_scale;

	int stopping;
} tdContext;

#define TAG "td-rdp"

/* --------------------------------------------------------------- the queue */

static void push_command(tdContext* td, td_cmd* cmd)
{
	EnterCriticalSection(&td->lock);
	cmd->next = NULL;
	if (td->queue_tail)
		td->queue_tail->next = cmd;
	else
		td->queue = cmd;
	td->queue_tail = cmd;
	LeaveCriticalSection(&td->lock);
	(void)SetEvent(td->arrived);
}

static td_cmd* pop_command(tdContext* td)
{
	EnterCriticalSection(&td->lock);
	td_cmd* cmd = td->queue;
	if (cmd)
	{
		td->queue = cmd->next;
		if (!td->queue)
			td->queue_tail = NULL;
	}
	LeaveCriticalSection(&td->lock);
	return cmd;
}

/* ---------------------------------------------------------------- the image */

static void note_damage(tdContext* td, UINT32 x1, UINT32 y1, UINT32 x2, UINT32 y2)
{
	if (x2 <= x1 || y2 <= y1)
		return;
	if (!td->dirty)
	{
		td->dx1 = x1;
		td->dy1 = y1;
		td->dx2 = x2;
		td->dy2 = y2;
		td->dirty = 1;
		return;
	}
	if (x1 < td->dx1)
		td->dx1 = x1;
	if (y1 < td->dy1)
		td->dy1 = y1;
	if (x2 > td->dx2)
		td->dx2 = x2;
	if (y2 > td->dy2)
		td->dy2 = y2;
}

/**
 * Sends the changed rectangle, if there is one and the last has been taken.
 *
 * The pixels are copied row by row because the framebuffer's stride is the
 * whole desktop's and the rectangle's is its own. Alpha is written as it goes:
 * the desktop has none, and a canvas handed a zero there draws nothing at all.
 */
static void flush_frame(tdContext* td)
{
	rdpGdi* gdi = td->common.context.gdi;
	if (!gdi || !gdi->primary_buffer || !td->dirty || td->inflight)
		return;

	const UINT32 x = td->dx1;
	const UINT32 y = td->dy1;
	const UINT32 w = td->dx2 - td->dx1;
	const UINT32 h = td->dy2 - td->dy1;

	const size_t needed = (size_t)w * h * 4u + 8u;
	if (needed > td->scratch_size)
	{
		BYTE* grown = realloc(td->scratch, needed);
		if (!grown)
			return;
		td->scratch = grown;
		td->scratch_size = needed;
	}

	BYTE* head = td->scratch;
	head[0] = (BYTE)(x & 0xFF);
	head[1] = (BYTE)((x >> 8) & 0xFF);
	head[2] = (BYTE)(y & 0xFF);
	head[3] = (BYTE)((y >> 8) & 0xFF);
	head[4] = (BYTE)(w & 0xFF);
	head[5] = (BYTE)((w >> 8) & 0xFF);
	head[6] = (BYTE)(h & 0xFF);
	head[7] = (BYTE)((h >> 8) & 0xFF);

	BYTE* out = td->scratch + 8;
	for (UINT32 row = 0; row < h; row++)
	{
		const BYTE* src = gdi->primary_buffer + (size_t)(y + row) * gdi->stride + (size_t)x * 4u;
		memcpy(out, src, (size_t)w * 4u);
		for (UINT32 px = 0; px < w; px++)
			out[px * 4u + 3u] = 0xFF;
		out += (size_t)w * 4u;
	}

	td->dirty = 0;
	if (td_write_record(TD_REC_FRAME, td->scratch, needed))
		td->inflight = 1;
	else
		td->stopping = 1;
}

static BOOL td_begin_paint(rdpContext* context)
{
	rdpGdi* gdi = context->gdi;
	if (gdi && gdi->primary && gdi->primary->hdc && gdi->primary->hdc->hwnd)
		gdi->primary->hdc->hwnd->invalid->null = TRUE;
	return TRUE;
}

static BOOL td_end_paint(rdpContext* context)
{
	tdContext* td = (tdContext*)context;
	rdpGdi* gdi = context->gdi;
	if (!gdi || !gdi->primary || !gdi->primary->hdc || !gdi->primary->hdc->hwnd)
		return TRUE;

	const HGDI_RGN invalid = gdi->primary->hdc->hwnd->invalid;
	if (!invalid || invalid->null)
		return TRUE;

	/* Clamped rather than trusted. A rectangle reaching past the framebuffer
	 * would be read out of bounds here, and the server is on the other side of
	 * a network. */
	INT32 x1 = invalid->x < 0 ? 0 : invalid->x;
	INT32 y1 = invalid->y < 0 ? 0 : invalid->y;
	INT64 x2 = (INT64)invalid->x + invalid->w;
	INT64 y2 = (INT64)invalid->y + invalid->h;
	if (x2 > gdi->width)
		x2 = gdi->width;
	if (y2 > gdi->height)
		y2 = gdi->height;
	if (x2 <= x1 || y2 <= y1)
		return TRUE;

	note_damage(td, (UINT32)x1, (UINT32)y1, (UINT32)x2, (UINT32)y2);
	flush_frame(td);
	return TRUE;
}

static BOOL td_desktop_resize(rdpContext* context)
{
	tdContext* td = (tdContext*)context;
	rdpSettings* settings = context->settings;
	const UINT32 width = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
	const UINT32 height = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);

	if (!gdi_resize(context->gdi, width, height))
		return FALSE;

	/* Everything is new, and the frame in flight described a screen that no
	 * longer exists. */
	td->dirty = 0;
	td->inflight = 0;
	note_damage(td, 0, 0, width, height);
	td_event("{\"e\":\"size\",\"width\":%u,\"height\":%u}", width, height);
	flush_frame(td);
	return TRUE;
}

/* -------------------------------------------------------------- the pointer */

static BOOL td_pointer_new(rdpContext* context, rdpPointer* pointer)
{
	tdPointer* ptr = (tdPointer*)pointer;
	rdpGdi* gdi = context->gdi;
	if (!ptr || !gdi)
		return FALSE;

	ptr->pixels = malloc((size_t)pointer->width * pointer->height * 4u);
	if (!ptr->pixels)
		return FALSE;

	/* Into the same byte order as the picture, so the renderer has one rule
	 * for both and the cursor cannot come out with its colours swapped while
	 * the desktop looks right. */
	if (!freerdp_image_copy_from_pointer_data(
	        ptr->pixels, PIXEL_FORMAT_RGBA32, 0, 0, 0, pointer->width, pointer->height,
	        pointer->xorMaskData, pointer->lengthXorMask, pointer->andMaskData,
	        pointer->lengthAndMask, pointer->xorBpp, &gdi->palette))
	{
		free(ptr->pixels);
		ptr->pixels = NULL;
		return FALSE;
	}
	return TRUE;
}

static void td_pointer_free(rdpContext* context, rdpPointer* pointer)
{
	tdPointer* ptr = (tdPointer*)pointer;
	WINPR_UNUSED(context);
	if (!ptr)
		return;
	free(ptr->pixels);
	ptr->pixels = NULL;
}

static BOOL td_pointer_set(rdpContext* context, rdpPointer* pointer)
{
	tdPointer* ptr = (tdPointer*)pointer;
	WINPR_UNUSED(context);
	if (!ptr || !ptr->pixels)
		return TRUE;

	const size_t pixels = (size_t)pointer->width * pointer->height * 4u;
	BYTE* record = malloc(pixels + 8u);
	if (!record)
		return TRUE;

	record[0] = (BYTE)(pointer->width & 0xFF);
	record[1] = (BYTE)((pointer->width >> 8) & 0xFF);
	record[2] = (BYTE)(pointer->height & 0xFF);
	record[3] = (BYTE)((pointer->height >> 8) & 0xFF);
	record[4] = (BYTE)(pointer->xPos & 0xFF);
	record[5] = (BYTE)((pointer->xPos >> 8) & 0xFF);
	record[6] = (BYTE)(pointer->yPos & 0xFF);
	record[7] = (BYTE)((pointer->yPos >> 8) & 0xFF);
	memcpy(record + 8, ptr->pixels, pixels);

	(void)td_write_record(TD_REC_CURSOR, record, pixels + 8u);
	free(record);
	return TRUE;
}

static BOOL td_pointer_set_null(rdpContext* context)
{
	const BYTE hidden = 0;
	WINPR_UNUSED(context);
	(void)td_write_record(TD_REC_CURSOR_STATE, &hidden, 1);
	return TRUE;
}

static BOOL td_pointer_set_default(rdpContext* context)
{
	const BYTE arrow = 1;
	WINPR_UNUSED(context);
	(void)td_write_record(TD_REC_CURSOR_STATE, &arrow, 1);
	return TRUE;
}

static BOOL td_pointer_set_position(rdpContext* context, UINT32 x, UINT32 y)
{
	/* The server moving the pointer, which happens when something over there
	 * warps it. Reported rather than obeyed: the renderer cannot move the
	 * physical mouse, and a page that could would be a page nobody wants. */
	WINPR_UNUSED(context);
	td_event("{\"e\":\"pointer\",\"x\":%u,\"y\":%u}", x, y);
	return TRUE;
}

static BOOL register_pointer(rdpGraphics* graphics)
{
	rdpPointer pointer = { 0 };
	pointer.size = sizeof(tdPointer);
	pointer.New = td_pointer_new;
	pointer.Free = td_pointer_free;
	pointer.Set = td_pointer_set;
	pointer.SetNull = td_pointer_set_null;
	pointer.SetDefault = td_pointer_set_default;
	pointer.SetPosition = td_pointer_set_position;
	graphics_register_pointer(graphics, &pointer);
	return TRUE;
}

/* --------------------------------------------------------------- the resize */

static UINT td_display_caps(DispClientContext* disp, UINT32 maxNumMonitors,
                            UINT32 maxMonitorAreaFactorA, UINT32 maxMonitorAreaFactorB)
{
	tdContext* td = (tdContext*)disp->custom;
	WINPR_UNUSED(maxNumMonitors);
	WINPR_UNUSED(maxMonitorAreaFactorA);
	WINPR_UNUSED(maxMonitorAreaFactorB);

	/* The channel is opened by the *server*, a second or two after the session
	 * starts. Until this arrives a size request has nowhere to go — which is
	 * why the driving side is told, rather than left to guess from a desktop
	 * that quietly kept its original size. */
	if (td)
		td->disp_ready = 1;
	td_event("{\"e\":\"resizable\"}");
	return CHANNEL_RC_OK;
}

static void send_size(tdContext* td, UINT32 width, UINT32 height, UINT32 scale)
{
	DISPLAY_CONTROL_MONITOR_LAYOUT layout = { 0 };

	if (!td->disp || !td->disp_ready || !td->disp->SendMonitorLayout)
		return;

	layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
	layout.Left = 0;
	layout.Top = 0;
	layout.Width = width;
	layout.Height = height;
	layout.Orientation = ORIENTATION_LANDSCAPE;
	/* Zero means "not stated", which the far end is required to ignore — so a
	 * session that never asked for a density is unaffected by this field. */
	layout.DesktopScaleFactor = scale;
	layout.DeviceScaleFactor = scale ? 100 : 0;

	(void)td->disp->SendMonitorLayout(td->disp, 1, &layout);
}

/* -------------------------------------------------------------- the channels */

static void on_channel_connected(void* context, const ChannelConnectedEventArgs* e)
{
	tdContext* td = (tdContext*)context;

	if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0)
	{
		td->disp = (DispClientContext*)e->pInterface;
		td->disp->custom = td;
		td->disp->DisplayControlCaps = td_display_caps;
		return;
	}

	/* Everything else — the graphics pipeline above all, which this handler
	 * wires into the GDI for us — is FreeRDP's own business. */
	freerdp_client_OnChannelConnectedEventHandler(&td->common, e);
}

static void on_channel_disconnected(void* context, const ChannelDisconnectedEventArgs* e)
{
	tdContext* td = (tdContext*)context;

	if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0)
	{
		td->disp = NULL;
		td->disp_ready = 0;
		return;
	}
	freerdp_client_OnChannelDisconnectedEventHandler(&td->common, e);
}

/* ------------------------------------------------------- connect and cleanup */

static BOOL td_pre_connect(freerdp* instance)
{
	rdpContext* context = instance->context;

	if (!freerdp_settings_set_bool(context->settings, FreeRDP_CertificateCallbackPreferPEM, TRUE))
		return FALSE;

	if (PubSub_SubscribeChannelConnected(context->pubSub, on_channel_connected) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub, on_channel_disconnected) < 0)
		return FALSE;
	return TRUE;
}

static BOOL td_post_connect(freerdp* instance)
{
	rdpContext* context = instance->context;
	tdContext* td = (tdContext*)context;

	/* RGBA, in that byte order in memory, because that is what an ImageData
	 * in a browser is. Every other choice costs a swizzle over every pixel of
	 * every frame, for nothing. */
	if (!gdi_init(instance, PIXEL_FORMAT_RGBA32))
		return FALSE;

	if (!register_pointer(context->graphics))
		return FALSE;

	context->update->BeginPaint = td_begin_paint;
	context->update->EndPaint = td_end_paint;
	context->update->DesktopResize = td_desktop_resize;

	{
		const UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
		const UINT32 height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
		td_event("{\"e\":\"connected\",\"width\":%u,\"height\":%u}", width, height);
		note_damage(td, 0, 0, width, height);
		flush_frame(td);
	}
	return TRUE;
}

static void td_post_disconnect(freerdp* instance)
{
	if (!instance || !instance->context)
		return;
	PubSub_UnsubscribeChannelConnected(instance->context->pubSub, on_channel_connected);
	PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub, on_channel_disconnected);
	gdi_free(instance);
}

/**
 * Asks the application whether this certificate is acceptable, and waits.
 *
 * The certificate goes up whole, in PEM. TerminalDeck already has a store of
 * the ones it has been told to trust — shared with the RD Gateway code and
 * keyed by a fingerprint over the DER bytes — and handing over the fingerprint
 * FreeRDP computed would have meant a second store in a second format, saying
 * different things about the same host. So the answer comes from the one that
 * already exists, and this end only asks.
 *
 * A timeout refuses. Someone who has walked away has consented to nothing, and
 * a connect that hangs forever on an unanswered dialog is worse than one that
 * stops with a reason.
 */
static int td_verify_x509(freerdp* instance, const BYTE* data, size_t length, const char* hostname,
                          UINT16 port, DWORD flags)
{
	tdContext* td = (tdContext*)instance->context;
	char host_escaped[512];

	(void)ResetEvent(td->answered);
	td->trusted = 0;

	/* The PEM is text, but not this process's text: escaped like anything else
	 * that arrived over a network, into a buffer sized for the worst case of
	 * every byte needing six. */
	char* pem = malloc(length * 6u + 1u);
	if (!pem)
		return -1;
	{
		char* copy = malloc(length + 1u);
		if (!copy)
		{
			free(pem);
			return -1;
		}
		memcpy(copy, data, length);
		copy[length] = '\0';
		(void)td_json_escape(pem, length * 6u + 1u, copy);
		free(copy);
	}

	td_event("{\"e\":\"certificate\",\"host\":\"%s\",\"port\":%u,\"flags\":%u,\"pem\":\"%s\"}",
	         td_json_escape(host_escaped, sizeof(host_escaped), hostname), port, (unsigned)flags,
	         pem);
	free(pem);

	if (WaitForSingleObject(td->answered, 180000) != WAIT_OBJECT_0)
		return -1;
	return td->trusted ? 1 : -1;
}

static int td_logon_error(freerdp* instance, UINT32 data, UINT32 type)
{
	char escaped[512];
	char text[600];
	WINPR_UNUSED(instance);

	(void)snprintf(text, sizeof(text), "%s [%s]", freerdp_get_logon_error_info_data(data),
	               freerdp_get_logon_error_info_type(type));
	td_event("{\"e\":\"logon\",\"detail\":\"%s\"}",
	         td_json_escape(escaped, sizeof(escaped), text));
	return 1;
}

/* ---------------------------------------------------------------- the input */

static void apply_command(tdContext* td, const td_cmd* cmd)
{
	rdpContext* context = &td->common.context;
	rdpInput* input = context->input;
	const char* action = td_cmd_str(cmd, "a", "");

	if (strcmp(action, "mouse") == 0)
	{
		(void)freerdp_input_send_mouse_event(input, (UINT16)td_cmd_int(cmd, "flags", 0),
		                                     (UINT16)td_cmd_int(cmd, "x", 0),
		                                     (UINT16)td_cmd_int(cmd, "y", 0));
	}
	else if (strcmp(action, "xmouse") == 0)
	{
		(void)freerdp_input_send_extended_mouse_event(input, (UINT16)td_cmd_int(cmd, "flags", 0),
		                                              (UINT16)td_cmd_int(cmd, "x", 0),
		                                              (UINT16)td_cmd_int(cmd, "y", 0));
	}
	else if (strcmp(action, "wheel") == 0)
	{
		/* The rotation travels in the low bits of the same field as the flags,
		 * as a signed step, and is clamped to what that field holds. Encoded
		 * here rather than up there because it is a detail of [MS-RDPBCGR]
		 * and not of any renderer. */
		int delta = td_cmd_int(cmd, "delta", 0);
		UINT16 flags = td_cmd_bool(cmd, "horizontal", 0) ? PTR_FLAGS_HWHEEL : PTR_FLAGS_WHEEL;
		if (delta < 0)
		{
			delta = -delta;
			flags |= PTR_FLAGS_WHEEL_NEGATIVE;
		}
		if (delta > 0xFF)
			delta = 0xFF;
		flags |= (UINT16)(delta & WheelRotationMask);
		(void)freerdp_input_send_mouse_event(input, flags, (UINT16)td_cmd_int(cmd, "x", 0),
		                                     (UINT16)td_cmd_int(cmd, "y", 0));
	}
	else if (strcmp(action, "key") == 0)
	{
		UINT16 flags = td_cmd_bool(cmd, "down", 1) ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE;
		if (td_cmd_bool(cmd, "ext", 0))
			flags |= KBD_FLAGS_EXTENDED;
		(void)freerdp_input_send_keyboard_event(input, flags, (UINT8)td_cmd_int(cmd, "code", 0));
	}
	else if (strcmp(action, "unicode") == 0)
	{
		const UINT16 flags = td_cmd_bool(cmd, "down", 1) ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE;
		(void)freerdp_input_send_unicode_keyboard_event(input, flags,
		                                                (UINT16)td_cmd_int(cmd, "code", 0));
	}
	else if (strcmp(action, "sync") == 0)
	{
		(void)freerdp_input_send_synchronize_event(input, (UINT32)td_cmd_int(cmd, "flags", 0));
	}
	else if (strcmp(action, "focus") == 0)
	{
		/* The far side needs telling when the pane stops being typed into, or
		 * a modifier held while focus left is still held over there. */
		(void)freerdp_input_send_focus_in_event(input, (UINT16)td_cmd_int(cmd, "flags", 0));
	}
	else if (strcmp(action, "resize") == 0)
	{
		const UINT32 width = (UINT32)td_cmd_int(cmd, "width", 0);
		const UINT32 height = (UINT32)td_cmd_int(cmd, "height", 0);
		const UINT32 scale = (UINT32)td_cmd_int(cmd, "scale", 0);
		/* Sizes must be even; an odd one is refused outright by some servers
		 * and quietly rounded by others, which is worse. */
		const UINT32 w = width & ~1u;
		const UINT32 h = height & ~1u;
		if (w >= 200 && h >= 200 &&
		    (w != td->want_width || h != td->want_height || scale != td->want_scale))
		{
			td->want_width = w;
			td->want_height = h;
			td->want_scale = scale;
			send_size(td, w, h, scale);
		}
	}
	else if (strcmp(action, "ack") == 0)
	{
		td->inflight = 0;
		flush_frame(td);
	}
	else if (strcmp(action, "refresh") == 0)
	{
		rdpGdi* gdi = context->gdi;
		if (gdi)
		{
			td->inflight = 0;
			note_damage(td, 0, 0, gdi->width, gdi->height);
			flush_frame(td);
		}
	}
	else if (strcmp(action, "stop") == 0)
	{
		td->stopping = 1;
		freerdp_abort_connect_context(context);
	}
}

static void drain_commands(tdContext* td)
{
	(void)ResetEvent(td->arrived);
	for (;;)
	{
		td_cmd* cmd = pop_command(td);
		if (!cmd)
			return;
		apply_command(td, cmd);
		td_cmd_free(cmd);
	}
}

/**
 * Reads the pipe for as long as it is open.
 *
 * Two messages never reach the queue. `cert` is an answer something on the
 * main thread is already blocked waiting for, and `stop` has to work even when
 * that thread is inside a connect that will not return — both are handled here
 * and at once.
 */
static DWORD WINAPI reader_thread(LPVOID arg)
{
	tdContext* td = (tdContext*)arg;
	rdpContext* context = &td->common.context;

	for (;;)
	{
		td_cmd* cmd = td_cmd_read();
		if (!cmd)
			break;

		const char* action = td_cmd_str(cmd, "a", "");
		if (strcmp(action, "cert") == 0)
		{
			td->trusted = td_cmd_bool(cmd, "trust", 0);
			(void)SetEvent(td->answered);
			td_cmd_free(cmd);
			continue;
		}
		if (strcmp(action, "stop") == 0)
		{
			td->stopping = 1;
			td_cmd_free(cmd);
			freerdp_abort_connect_context(context);
			break;
		}
		push_command(td, cmd);
	}

	/* The pipe closing is the application going away, however it went. */
	td->stopping = 1;
	(void)SetEvent(td->answered);
	freerdp_abort_connect_context(context);
	return 0;
}

/* ------------------------------------------------------------- the settings */

static BOOL configure(tdContext* td, const td_cmd* start)
{
	rdpSettings* s = td->common.context.settings;
	const char* gateway = td_cmd_str(start, "gatewayHost", "");

#define SET_STR(key, value)                                       \
	do                                                            \
	{                                                             \
		if (!freerdp_settings_set_string(s, key, (value)))         \
			return FALSE;                                          \
	} while (0)
#define SET_BOOL(key, value)                                      \
	do                                                            \
	{                                                             \
		if (!freerdp_settings_set_bool(s, key, (value) ? TRUE : FALSE)) \
			return FALSE;                                          \
	} while (0)
#define SET_U32(key, value)                                       \
	do                                                            \
	{                                                             \
		if (!freerdp_settings_set_uint32(s, key, (UINT32)(value)))  \
			return FALSE;                                          \
	} while (0)

	SET_STR(FreeRDP_ServerHostname, td_cmd_str(start, "host", ""));
	SET_U32(FreeRDP_ServerPort, td_cmd_int(start, "port", 3389));
	SET_STR(FreeRDP_Username, td_cmd_str(start, "user", ""));
	SET_STR(FreeRDP_Domain, td_cmd_str(start, "domain", ""));
	SET_STR(FreeRDP_Password, td_cmd_str(start, "password", ""));

	SET_U32(FreeRDP_DesktopWidth, td_cmd_int(start, "width", 1280) & ~1);
	SET_U32(FreeRDP_DesktopHeight, td_cmd_int(start, "height", 800) & ~1);
	/**
	 * Thirty-two bits, asked for plainly.
	 *
	 * The host that prompted all of this dictates sixteen, and will go on
	 * dictating it — the policy is over there. Asking for the most this end
	 * can take is still right: where the server has no such policy this is the
	 * difference between smooth gradients and banded ones, and where it does,
	 * the request costs nothing and is simply refused.
	 */
	SET_U32(FreeRDP_ColorDepth, 32);

	/**
	 * The graphics pipeline, which is the entire reason this client replaced
	 * the last one. H.264 in both its forms, progressive RemoteFX under it,
	 * and RemoteFX below that: what the server picks is the server's business,
	 * and every one of them beats run-length-encoded bitmaps.
	 */
	SET_BOOL(FreeRDP_SupportGraphicsPipeline, TRUE);
	SET_BOOL(FreeRDP_GfxH264, TRUE);
	SET_BOOL(FreeRDP_GfxAVC444, TRUE);
	SET_BOOL(FreeRDP_GfxAVC444v2, TRUE);
	SET_BOOL(FreeRDP_GfxProgressive, TRUE);
	SET_BOOL(FreeRDP_GfxSmallCache, FALSE);
	SET_BOOL(FreeRDP_GfxThinClient, FALSE);
	SET_BOOL(FreeRDP_RemoteFxCodec, TRUE);
	SET_BOOL(FreeRDP_SoftwareGdi, TRUE);
	/* The sample client sets this to parse a session without drawing it. Here
	 * it must be off, or there are no pixels at all. */
	SET_BOOL(FreeRDP_DeactivateClientDecoding, FALSE);

	/* Resizing the pane resizes the desktop, rather than stretching a picture
	 * of the wrong size — which is most of what "blurry" meant before. */
	SET_BOOL(FreeRDP_SupportDisplayControl, TRUE);
	SET_BOOL(FreeRDP_DynamicResolutionUpdate, TRUE);

	/* The density this display has, when the host asked for it to be sent.
	 * Stated at connect as well as on every resize, or the first screen the
	 * session draws is laid out for a density it is about to be told about —
	 * which is a visible relayout a second in. Zero leaves both fields unset,
	 * and the far end is required to ignore them. */
	{
		const UINT32 scale = (UINT32)td_cmd_int(start, "scale", 0);
		SET_U32(FreeRDP_DesktopScaleFactor, scale);
		SET_U32(FreeRDP_DeviceScaleFactor, scale ? 100 : 0);
		td->want_scale = scale;
	}

	/* Let the server measure the link and adapt, which is what makes a slow
	 * one bearable. */
	SET_BOOL(FreeRDP_NetworkAutoDetect, TRUE);
	SET_U32(FreeRDP_ConnectionType, CONNECTION_TYPE_AUTODETECT);

	if (td_cmd_bool(start, "sound", 0))
	{
		const char* const channel[] = { RDPSND_CHANNEL_NAME };
		SET_BOOL(FreeRDP_AudioPlayback, TRUE);
		/* Played by this process, through whatever the platform offers —
		 * CoreAudio here. The pixels have to cross into the renderer because
		 * that is where the canvas is; sound has no such reason to. */
		if (!freerdp_client_add_static_channel(s, 1, channel))
			return FALSE;
		if (!freerdp_client_add_dynamic_channel(s, 1, channel))
			return FALSE;
	}

	/* What the far end may spend effort on. Off by default in RDP and worth
	 * having on a link that can carry it; the caller decides. */
	SET_BOOL(FreeRDP_AllowFontSmoothing, td_cmd_bool(start, "fontSmoothing", 1));
	SET_BOOL(FreeRDP_AllowDesktopComposition, td_cmd_bool(start, "composition", 0));
	SET_BOOL(FreeRDP_DisableWallpaper, td_cmd_bool(start, "noWallpaper", 0));

	if (*gateway)
	{
		SET_BOOL(FreeRDP_GatewayEnabled, TRUE);
		SET_STR(FreeRDP_GatewayHostname, gateway);
		SET_U32(FreeRDP_GatewayPort, td_cmd_int(start, "gatewayPort", 443));
		SET_BOOL(FreeRDP_GatewayHttpTransport, TRUE);
		SET_BOOL(FreeRDP_GatewayRpcTransport, FALSE);
		/* Skip the gateway for a host that resolves to a private address, the
		 * way `gatewayusagemethod:4` does in an .rdp file. Off unless asked
		 * for: silently not using a gateway that was configured is worse than
		 * failing to reach a host. */
		SET_BOOL(FreeRDP_GatewayBypassLocal, td_cmd_bool(start, "gatewayBypassLocal", 0));

		/* Its own credentials, or the host's again — stated rather than
		 * inferred, because the two are the same on most deployments and
		 * different on exactly the ones where guessing wrong locks an account
		 * out. */
		if (td_cmd_bool(start, "gatewaySameCredentials", 1))
		{
			SET_BOOL(FreeRDP_GatewayUseSameCredentials, TRUE);
			SET_STR(FreeRDP_GatewayUsername, td_cmd_str(start, "user", ""));
			SET_STR(FreeRDP_GatewayDomain, td_cmd_str(start, "domain", ""));
			SET_STR(FreeRDP_GatewayPassword, td_cmd_str(start, "password", ""));
		}
		else
		{
			SET_BOOL(FreeRDP_GatewayUseSameCredentials, FALSE);
			SET_STR(FreeRDP_GatewayUsername, td_cmd_str(start, "gatewayUser", ""));
			SET_STR(FreeRDP_GatewayDomain, td_cmd_str(start, "gatewayDomain", ""));
			SET_STR(FreeRDP_GatewayPassword, td_cmd_str(start, "gatewayPassword", ""));
		}
	}

#undef SET_STR
#undef SET_BOOL
#undef SET_U32

	td->want_width = freerdp_settings_get_uint32(s, FreeRDP_DesktopWidth);
	td->want_height = freerdp_settings_get_uint32(s, FreeRDP_DesktopHeight);
	return TRUE;
}

/* ------------------------------------------------------------- the main loop */

static void run_session(tdContext* td)
{
	rdpContext* context = &td->common.context;
	HANDLE handles[MAXIMUM_WAIT_OBJECTS] = { 0 };

	if (!freerdp_connect(context->instance))
	{
		const UINT32 code = freerdp_get_last_error(context);
		char escaped[512];
		td_event("{\"e\":\"failed\",\"code\":%u,\"detail\":\"%s\"}", code,
		         td_json_escape(escaped, sizeof(escaped),
		                        freerdp_get_last_error_string(code)));
		return;
	}

	while (!freerdp_shall_disconnect_context(context) && !td->stopping)
	{
		/* One slot is kept back for the command event, so a message from the
		 * application wakes this thread as promptly as a packet does. */
		DWORD count = freerdp_get_event_handles(context, handles, ARRAYSIZE(handles) - 1);
		if (count == 0)
			break;
		handles[count++] = td->arrived;

		if (WaitForMultipleObjects(count, handles, FALSE, INFINITE) == WAIT_FAILED)
			break;

		drain_commands(td);
		if (td->stopping)
			break;
		if (!freerdp_check_event_handles(context))
			break;
	}

	{
		const UINT32 code = freerdp_get_last_error(context);
		char escaped[512];
		td_event("{\"e\":\"ended\",\"code\":%u,\"detail\":\"%s\"}", code,
		         td_json_escape(escaped, sizeof(escaped),
		                        freerdp_get_last_error_string(code)));
	}
	freerdp_disconnect(context->instance);
}

/* ------------------------------------------------------------- entry points */

static BOOL client_new(freerdp* instance, rdpContext* context)
{
	tdContext* td = (tdContext*)context;

	instance->PreConnect = td_pre_connect;
	instance->PostConnect = td_post_connect;
	instance->PostDisconnect = td_post_disconnect;
	instance->LogonErrorInfo = td_logon_error;
	/* The PEM callback, in preference to the fingerprint ones: FreeRDP asks
	 * this first when it is set, and it is the only one that hands over enough
	 * for the application's own trust store to recognise a certificate it has
	 * already been told about. */
	instance->VerifyX509Certificate = td_verify_x509;
	/* Deliberately no Authenticate callback: everything needed was given at
	 * start, and a prompt from a process with no terminal would hang. */

	InitializeCriticalSection(&td->lock);
	td->arrived = CreateEvent(NULL, TRUE, FALSE, NULL);
	td->answered = CreateEvent(NULL, TRUE, FALSE, NULL);
	return td->arrived != NULL && td->answered != NULL;
}

static void client_free(freerdp* instance, rdpContext* context)
{
	tdContext* td = (tdContext*)context;
	WINPR_UNUSED(instance);
	if (!context)
		return;

	while (td->queue)
	{
		td_cmd* cmd = td->queue;
		td->queue = cmd->next;
		td_cmd_free(cmd);
	}
	if (td->arrived)
		(void)CloseHandle(td->arrived);
	if (td->answered)
		(void)CloseHandle(td->answered);
	DeleteCriticalSection(&td->lock);
	free(td->scratch);
}

static int client_start(rdpContext* context)
{
	WINPR_UNUSED(context);
	return 0;
}

static int client_stop(rdpContext* context)
{
	WINPR_UNUSED(context);
	return 0;
}

int main(int argc, char* argv[])
{
	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	rdpContext* context = NULL;
	tdContext* td = NULL;
	td_cmd* start = NULL;
	HANDLE reader = NULL;
	int rc = 1;

	WINPR_UNUSED(argc);
	WINPR_UNUSED(argv);

	/* Before anything can be said, the pipe has to be ours alone. */
	if (!td_proto_init())
		return 1;

	entry.Version = RDP_CLIENT_INTERFACE_VERSION;
	entry.Size = sizeof(RDP_CLIENT_ENTRY_POINTS_V1);
	entry.ContextSize = sizeof(tdContext);
	entry.ClientNew = client_new;
	entry.ClientFree = client_free;
	entry.ClientStart = client_start;
	entry.ClientStop = client_stop;

	context = freerdp_client_context_new(&entry);
	if (!context)
		return 1;
	td = (tdContext*)context;

	/**
	 * The first message is read here, on this thread, before the reader exists.
	 *
	 * It carries the password, and it decides every setting — so there is
	 * nothing for a second thread to race with until it has been applied.
	 */
	start = td_cmd_read();
	if (!start || strcmp(td_cmd_str(start, "a", ""), "start") != 0)
	{
		td_event("{\"e\":\"failed\",\"detail\":\"the first message was not a start\"}");
		goto done;
	}

	if (!configure(td, start))
	{
		td_event("{\"e\":\"failed\",\"detail\":\"the settings were refused\"}");
		goto done;
	}

	reader = CreateThread(NULL, 0, reader_thread, td, 0, NULL);
	if (!reader)
	{
		td_event("{\"e\":\"failed\",\"detail\":\"could not start the reader\"}");
		goto done;
	}

	if (freerdp_client_start(context) != 0)
	{
		td_event("{\"e\":\"failed\",\"detail\":\"the client would not start\"}");
		goto done;
	}

	run_session(td);
	(void)freerdp_client_stop(context);
	rc = 0;

done:
	td_cmd_free(start);
	if (reader)
	{
		/* The reader is blocked on a pipe that only the far side can close, so
		 * it is not waited for: the process is ending and the descriptor goes
		 * with it. */
		(void)CloseHandle(reader);
	}
	freerdp_client_context_free(context);
	return rc;
}
