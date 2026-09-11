/* Exercise the real clipboard callbacks, without an RDP server. */
#define main td_client_main
#define td_write_record capture_record
#include "td_rdp.c"
#undef td_write_record
#undef main
#include <assert.h>

static char captured[1024];
static size_t captured_length;
static unsigned records, requests;
static UINT32 requested;
int capture_record(uint8_t type, const void* payload, size_t length)
{
	assert(type == TD_REC_CLIPBOARD && length < sizeof(captured));
	memcpy(captured, payload, length);
	captured[length] = 0;
	captured_length = length;
	records++;
	return 1;
}
static UINT acknowledge(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_LIST_RESPONSE* response)
{
	(void)ctx;
	assert(response->common.msgFlags == CB_RESPONSE_OK);
	return CHANNEL_RC_OK;
}
static UINT request_data(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_REQUEST* request)
{
	(void)ctx;
	requested = request->requestedFormatId;
	requests++;
	return CHANNEL_RC_OK;
}
static void offer(CliprdrClientContext* ctx)
{
	CLIPRDR_FORMAT formats[] = { { CF_TEXT, NULL }, { 49300, "HTML Format" },
	                            { CF_UNICODETEXT, NULL } };
	CLIPRDR_FORMAT_LIST list = { 0 };
	list.numFormats = 3;
	list.formats = formats;
	assert(td_clip_server_format_list(ctx, &list) == CHANNEL_RC_OK);
}
static void respond(CliprdrClientContext* ctx, const char* text)
{
	size_t chars = 0;
	WCHAR* wide = ConvertUtf8ToWCharAlloc(text, &chars);
	CLIPRDR_FORMAT_DATA_RESPONSE response = { 0 };
	assert(wide);
	response.common.msgFlags = CB_RESPONSE_OK;
	response.common.dataLen = (UINT32)((chars + 1) * sizeof(WCHAR));
	response.requestedFormatData = (const BYTE*)wide;
	assert(td_clip_server_format_data_response(ctx, &response) == CHANNEL_RC_OK);
	free(wide);
}
static UINT receive_local(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_RESPONSE* response)
{
	/* Through the same accessor the callbacks use. Casting `custom` straight to
	 * a `tdContext` is what crashed here: since the file helper was added it
	 * holds the helper, and the helper holds us. */
	tdContext* td = td_of(ctx);
	assert(response->common.msgFlags == CB_RESPONSE_OK);
	assert(response->common.dataLen >= 2 && response->common.dataLen % 2 == 0);
	const BYTE* bytes = response->requestedFormatData;
	assert(bytes[response->common.dataLen - 1] == 0 && bytes[response->common.dataLen - 2] == 0);
	size_t length = 0;
	char* decoded = ConvertWCharNToUtf8Alloc((const WCHAR*)bytes,
	                                       response->common.dataLen / sizeof(WCHAR), &length);
	assert(decoded && strcmp(decoded, td->clip_local) == 0);
	free(decoded);
	return CHANNEL_RC_OK;
}
int main(void)
{
	tdContext td = { 0 };
	CliprdrClientContext ctx = { 0 };
	const char* texts[] = { "Notepad text", "Folder name",
		                    "Текст с HTML страницы — тест 😀\r\nСтрока 2", "" };
	/*
	 * Built the way a live session builds it, and not shortened to
	 * `ctx.custom = &td`. The file helper takes `custom` for itself and keeps
	 * what it was handed, so every callback reaches this context through it —
	 * a test that skipped this step would hand the code a `tdContext` where it
	 * expects a `CliprdrFileContext`, read one as the other, and crash. It did.
	 */
	td.clip_system = ClipboardCreate();
	td.clip_files = cliprdr_file_context_new(&td);
	assert(td.clip_system && td.clip_files);
	ctx.custom = td.clip_files;
	ctx.ClientFormatListResponse = acknowledge;
	ctx.ClientFormatDataRequest = request_data;
	ctx.ClientFormatDataResponse = receive_local;
	InitializeCriticalSection(&td.clip);
	for (size_t i = 0; i < sizeof(texts) / sizeof(texts[0]); i++)
	{
		offer(&ctx);
		assert(requested == CF_UNICODETEXT);
		/* An unrelated request in the opposite direction must not choose
		 * the decoder for our response. Initially this field is zero. */
		ctx.lastRequestedFormatId = i == 0 ? 0 : CF_TEXT;
		respond(&ctx, texts[i]);
		assert(captured_length == strlen(texts[i]));
		assert(memcmp(captured, texts[i], captured_length) == 0);
		/* The same text pasted into RDP must remain terminated UTF-16. */
		td.clip_local = _strdup(texts[i]);
		CLIPRDR_FORMAT_DATA_REQUEST request = { 0 };
		request.requestedFormatId = CF_UNICODETEXT;
		assert(td_clip_server_format_data_request(&ctx, &request) == CHANNEL_RC_OK);
		free(td.clip_local);
		td.clip_local = NULL;
	}
	/* Rapid successive copies: don't mislabel or publish the stale response. */
	offer(&ctx);
	unsigned before_requests = requests, before_records = records;
	offer(&ctx);
	offer(&ctx);
	assert(requests == before_requests);
	respond(&ctx, "old clipboard");
	assert(records == before_records && requests == before_requests + 1);
	respond(&ctx, "new clipboard");
	assert(records == before_records + 1 && strcmp(captured, "new clipboard") == 0);
	/* An unsolicited response cannot become text. */
	respond(&ctx, "unsolicited");
	assert(records == before_records + 1);
	cliprdr_file_context_free(td.clip_files);
	ClipboardDestroy(td.clip_system);
	DeleteCriticalSection(&td.clip);
	return 0;
}
