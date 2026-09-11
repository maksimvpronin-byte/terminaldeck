/* Exercise the real clipboard callbacks, without an RDP server. */
#define main td_client_main
#define td_write_record capture_record
#include "td_rdp.c"
#undef td_write_record
#undef main
#include <assert.h>
#ifdef _WIN32
#include <direct.h>
#define getcwd _getcwd
#else
#include <unistd.h>
#endif

static char captured[1024];
static size_t captured_length;
static unsigned records, requests;
static UINT32 requested;
static uint8_t captured_type;
int capture_record(uint8_t type, const void* payload, size_t length)
{
	if (type == TD_REC_CLIP_RESET) return 1;
	assert(length < sizeof(captured));
	captured_type = type;
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
static UINT capabilities(CliprdrClientContext* ctx, const CLIPRDR_CAPABILITIES* caps)
{
	(void)ctx;
	const CLIPRDR_GENERAL_CAPABILITY_SET* set = (const CLIPRDR_GENERAL_CAPABILITY_SET*)caps->capabilitySets;
	assert(set->generalFlags & CB_STREAM_FILECLIP_ENABLED);
	assert(set->generalFlags & CB_FILECLIP_NO_FILE_PATHS);
	return CHANNEL_RC_OK;
}
static UINT offered(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_LIST* list)
{
	(void)ctx; (void)list;
	return CHANNEL_RC_OK;
}
static UINT file_list_response(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_RESPONSE* response)
{
	(void)ctx;
	assert(response->common.msgFlags == CB_RESPONSE_OK);
	FILEDESCRIPTORW* descriptors = NULL;
	UINT32 count = 0;
	assert(cliprdr_parse_file_list(response->requestedFormatData, response->common.dataLen,
	                             &descriptors, &count) == CHANNEL_RC_OK);
	assert(count == 1 && descriptors[0].nFileSizeLow == 10);
	free(descriptors);
	return CHANNEL_RC_OK;
}
static UINT local_file_bytes(CliprdrClientContext* ctx, const CLIPRDR_FILE_CONTENTS_RESPONSE* response)
{
	(void)ctx;
	assert(response->common.msgFlags == CB_RESPONSE_OK);
	assert(response->streamId == 17 && response->cbRequested == 4);
	assert(memcmp(response->requestedData, "3456", 4) == 0);
	return CHANNEL_RC_OK;
}
static void file_transfers(tdContext* td, CliprdrClientContext* ctx)
{
	td->cliprdr = ctx;
	assert(cliprdr_file_context_init(td->clip_files, ctx));
	assert(cliprdr_file_context_set_locally_available(td->clip_files, TRUE));
	ctx->ClientCapabilities = capabilities;
	ctx->ClientFormatList = offered;
	assert(td_clip_monitor_ready(ctx, NULL) == CHANNEL_RC_OK);
	CLIPRDR_GENERAL_CAPABILITY_SET general = { 0 };
	general.capabilitySetType = CB_CAPSTYPE_GENERAL;
	general.capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN;
	general.generalFlags = CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS;
	CLIPRDR_CAPABILITIES caps = { 0 };
	caps.cCapabilitiesSets = 1;
	caps.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
	assert(td_clip_caps(ctx, &caps) == CHANNEL_RC_OK);
	assert(cliprdr_file_context_current_flags(td->clip_files) & CB_STREAM_FILECLIP_ENABLED);

	char temp[4096], path[4200];
	assert(getcwd(temp, sizeof(temp)));
	snprintf(path, sizeof(path), "%s/td-clipboard-test-%%20.tmp", temp);
	FILE* file = fopen(path, "wbx");
	assert(file && fwrite("0123456789", 1, 10, file) == 10);
	fclose(file);
	char uri[4300];
	for (char* ch = path; *ch; ch++) if (*ch == '\\') *ch = '/';
	size_t used = (size_t)snprintf(uri, sizeof(uri), "file://%s", path[0] == '/' ? "" : "/");
	for (const char* ch = path; *ch; ch++)
	{
		if (*ch == '%') { memcpy(uri + used, "%25", 3); used += 3; }
		else { uri[used++] = *ch; }
	}
	uri[used] = 0;
	td->clip_uris = _strdup(uri);
	ctx->ClientFormatDataResponse = file_list_response;
	assert(td_clip_answer_files(ctx, td) == CHANNEL_RC_OK);
	ctx->ClientFileContentsResponse = local_file_bytes;
	CLIPRDR_FILE_CONTENTS_REQUEST request = { 0 };
	request.streamId = 17;
	request.dwFlags = FILECONTENTS_RANGE;
	request.nPositionLow = 3;
	request.cbRequested = 4;
	assert(td_clip_local_request(ctx, &request) == CHANNEL_RC_OK);
#ifdef _WIN32
	/* Explorer preview and other readers must not prevent sending the bytes.
	 * Unpatched WinPR opens with share mode zero and fails this request. */
	WCHAR* wide_path = ConvertUtf8ToWCharAlloc(path, NULL);
	assert(wide_path);
	HANDLE reader = CreateFileW(wide_path, GENERIC_READ, FILE_SHARE_READ, NULL,
	                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
	free(wide_path);
	assert(reader != INVALID_HANDLE_VALUE);
	assert(td_clip_local_request(ctx, &request) == CHANNEL_RC_OK);
	assert(CloseHandle(reader));
#endif
	/*
	 * A file list must still go out when the capability exchange left no trace
	 * here. The far end is asking for a format offered only when files are
	 * waiting, so it does support them; WinPR, told otherwise, serialises
	 * nothing at all and the paste fails with the far end none the wiser.
	 */
	assert(cliprdr_file_context_remote_set_flags(td->clip_files, 0));
	assert(td_clip_answer_files(ctx, td) == CHANNEL_RC_OK);
	assert(td_clip_send_flags(td) & CB_STREAM_FILECLIP_ENABLED);
	assert(cliprdr_file_context_remote_set_flags(td->clip_files,
	                                             CB_STREAM_FILECLIP_ENABLED |
	                                                 CB_FILECLIP_NO_FILE_PATHS));

	free(td->clip_uris);
	td->clip_uris = NULL;
	assert(remove(path) == 0);

	CLIPRDR_FORMAT formats[] = { { CF_UNICODETEXT, NULL }, { 49201, "FileGroupDescriptorW" } };
	CLIPRDR_FORMAT_LIST list = { 0 };
	list.numFormats = 2;
	list.formats = formats;
	assert(td_clip_server_format_list(ctx, &list) == CHANNEL_RC_OK);
	assert(requested == 49201);
	const BYTE manifest[] = { 0, 0, 0, 0 };
	CLIPRDR_FORMAT_DATA_RESPONSE response = { 0 };
	response.common.msgFlags = CB_RESPONSE_OK;
	response.common.dataLen = sizeof(manifest);
	response.requestedFormatData = manifest;
	assert(td_clip_server_format_data_response(ctx, &response) == CHANNEL_RC_OK);
	assert(captured_type == TD_REC_CLIP_FILES && captured_length == 4);
	CLIPRDR_FILE_CONTENTS_RESPONSE chunk = { 0 };
	chunk.streamId = 17;
	chunk.common.msgFlags = CB_RESPONSE_OK;
	chunk.cbRequested = 4;
	chunk.requestedData = (const BYTE*)"3456";
	assert(td_clip_file_response(ctx, &chunk) == CHANNEL_RC_OK);
	assert(captured_type == TD_REC_CLIP_CHUNK && captured_length == 12);
	assert(captured[0] == 17 && captured[4] == 1 && memcmp(captured + 8, "3456", 4) == 0);
	assert(cliprdr_file_context_uninit(td->clip_files, ctx));
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
	file_transfers(&td, &ctx);
	cliprdr_file_context_free(td.clip_files);
	ClipboardDestroy(td.clip_system);
	DeleteCriticalSection(&td.clip);
	return 0;
}
