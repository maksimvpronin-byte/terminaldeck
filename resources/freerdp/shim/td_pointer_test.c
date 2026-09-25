/* Convert pointers the way the shim does, without a server. */
#define main td_client_main
#include "td_rdp.c"
#undef main
#include <assert.h>

/* The alpha of the pixel at (x, y) of a 2x2 RGBA image. */
static BYTE alpha(const BYTE* rgba, int x, int y)
{
	return rgba[(y * 2 + x) * 4 + 3];
}

int main(void)
{
	/*
	 * A 2x2 monochrome cursor sent as 32 bits with no alpha, bottom row first,
	 * as Windows sends its I-beam:
	 *   top:    A drawn black (AND 0)     B inverting (AND 1, white)
	 *   bottom: C transparent (AND 1, 0)  D drawn white (AND 0)
	 */
	BYTE xorMask[16] = {
		/* bottom: C, D */ 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00,
		/* top:    A, B */ 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00,
	};
	/* One bit per pixel, rows padded to two bytes; bottom row first too. */
	BYTE andMask[4] = { 0x80, 0x00, 0x40, 0x00 };
	rdpPointer pointer = { 0 };
	pointer.width = 2;
	pointer.height = 2;
	pointer.xorBpp = 32;
	pointer.xorMaskData = xorMask;
	pointer.lengthXorMask = sizeof(xorMask);
	pointer.andMaskData = andMask;
	pointer.lengthAndMask = sizeof(andMask);
	gdiPalette palette = { 0 };
	BYTE out[16];

	/* Taken as FreeRDP reads it, the whole cursor is invisible. */
	assert(freerdp_image_copy_from_pointer_data(out, PIXEL_FORMAT_RGBA32, 0, 0, 0, 2, 2, xorMask,
	                                            sizeof(xorMask), andMask, sizeof(andMask), 32, &palette));
	assert(!td_any_visible(out, 4));

	/* Read again by the mask, it can be seen. */
	assert(td_convert_pointer(out, &pointer, &palette));
	assert(alpha(out, 0, 0) == 0xFF && out[0] == 0x00); /* A: black */
	assert(alpha(out, 1, 0) == 0xFF);                    /* B: inverting, drawn as a checker */
	assert(alpha(out, 0, 1) == 0x00);                    /* C: transparent */
	assert(alpha(out, 1, 1) == 0xFF && out[12] == 0xFF); /* D: white */

	/* A cursor with alpha of its own is left exactly as FreeRDP drew it. */
	xorMask[11] = 0x80;
	BYTE plain[16];
	assert(freerdp_image_copy_from_pointer_data(plain, PIXEL_FORMAT_RGBA32, 0, 0, 0, 2, 2, xorMask,
	                                            sizeof(xorMask), andMask, sizeof(andMask), 32, &palette));
	assert(td_convert_pointer(out, &pointer, &palette));
	assert(memcmp(out, plain, sizeof(out)) == 0);

	/* A cursor meant to be invisible — mask all set, colour all black — stays so. */
	memset(xorMask, 0, sizeof(xorMask));
	BYTE all[4] = { 0xC0, 0x00, 0xC0, 0x00 };
	pointer.andMaskData = all;
	assert(td_convert_pointer(out, &pointer, &palette));
	assert(!td_any_visible(out, 4));
	return 0;
}
