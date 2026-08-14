#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#include <stdlib.h>
#include <string.h>
#include "SessEnvPublicRpc.h"

void * __RPC_USER MIDL_user_allocate(size_t size) { return malloc(size); }
void __RPC_USER MIDL_user_free(void *ptr) { free(ptr); }

static void usage(void) {
  wprintf(L"Usage: SessEnvProbe.exe --call <sessionId> [control] [ask] [--hold <seconds>]\n");
}

static int has_flag(int argc, wchar_t **argv, const wchar_t *name) {
  for (int i = 3; i < argc; i++) {
    if (_wcsicmp(argv[i], name) == 0) return 1;
  }
  return 0;
}

/* What the host's policy made of the request. */
static const wchar_t *response_name(SHADOW_REQUEST_RESPONSE response) {
  switch (response) {
    case SHADOW_REQUEST_RESPONSE_ALLOW: return L"ALLOW";
    case SHADOW_REQUEST_RESPONSE_DECLINE: return L"DECLINE";
    case SHADOW_REQUEST_RESPONSE_POLICY_PERMISSION_REQUIRED: return L"POLICY_PERMISSION_REQUIRED";
    case SHADOW_REQUEST_RESPONSE_POLICY_DISABLED: return L"POLICY_DISABLED";
    case SHADOW_REQUEST_RESPONSE_POLICY_VIEW_ONLY: return L"POLICY_VIEW_ONLY";
    case SHADOW_REQUEST_RESPONSE_POLICY_VIEW_ONLY_PERMISSION_REQUIRED:
      return L"POLICY_VIEW_ONLY_PERMISSION_REQUIRED";
    case SHADOW_REQUEST_RESPONSE_SESSION_ALREADY_CONTROLLED: return L"SESSION_ALREADY_CONTROLLED";
    default: return L"UNKNOWN";
  }
}

/* Seconds to keep the shadow session open after printing the invitation. */
static unsigned long hold_seconds(int argc, wchar_t **argv) {
  for (int i = 1; i + 1 < argc; i++) {
    if (_wcsicmp(argv[i], L"--hold") == 0) return wcstoul(argv[i + 1], NULL, 10);
  }
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 3 || _wcsicmp(argv[1], L"--call") != 0) {
    usage();
    return 2;
  }

  unsigned long session = wcstoul(argv[2], NULL, 10);
  SHADOW_CONTROL_REQUEST control = has_flag(argc, argv, L"control")
    ? SHADOW_CONTROL_REQUEST_TAKECONTROL
    : SHADOW_CONTROL_REQUEST_VIEW;

  /* Silent by default: shadowing should not stop to collect a click. Asking was
     tried and the host answered ALLOW either way, so consent is not what stands
     between this probe and a working session. "ask" restores the prompt. */
  SHADOW_PERMISSION_REQUEST wants_permission = has_flag(argc, argv, L"ask")
    ? SHADOW_PERMISSION_REQUEST_REQUESTPERMISSION
    : SHADOW_PERMISSION_REQUEST_SILENT;

  RPC_WSTR bindingString = NULL;
  handle_t binding = NULL;
  RPC_STATUS status = RpcStringBindingComposeW(
    NULL, (RPC_WSTR)L"ncacn_np", NULL,
    (RPC_WSTR)L"\\pipe\\SessEnvPublicRpc", NULL, &bindingString);
  if (status != RPC_S_OK) {
    wprintf(L"RpcStringBindingComposeW failed: %lu\n", status);
    return 3;
  }

  status = RpcBindingFromStringBindingW(bindingString, &binding);
  RpcStringFreeW(&bindingString);
  if (status != RPC_S_OK) {
    wprintf(L"RpcBindingFromStringBindingW failed: %lu\n", status);
    return 3;
  }

  // The named pipe endpoint still requires an authenticated RPC context.
  // Without this, SessEnvPublicRpc sees an anonymous caller and returns 5 even
  // when the WinRM process itself runs as a local administrator.
  status = RpcBindingSetAuthInfoW(
    binding, NULL, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
    RPC_C_AUTHN_GSS_NEGOTIATE, NULL, RPC_C_AUTHZ_NONE);
  if (status != RPC_S_OK) {
    wprintf(L"RpcBindingSetAuthInfoW failed: %lu\n", status);
    RpcBindingFree(&binding);
    return 3;
  }

  wchar_t invitation[8192];
  memset(invitation, 0, sizeof(invitation));
  SHADOW_REQUEST_RESPONSE permission = SHADOW_REQUEST_RESPONSE_DECLINE;
  HRESULT result = E_FAIL;

  RpcTryExcept {
    result = RpcShadow2(
      binding, session, control, wants_permission,
      &permission, invitation, 8192);
  }
  RpcExcept(1) {
    wprintf(L"RpcShadow2 exception: %lu\n", RpcExceptionCode());
    RpcBindingFree(&binding);
    return 4;
  }
  RpcEndExcept

  wprintf(L"HRESULT=0x%08lX, response=%u (%ls), invitationChars=%zu\n",
    (unsigned long)result, (unsigned int)permission,
    response_name(permission), wcslen(invitation));
  if (result == S_OK) wprintf(L"%ls\n", invitation);
  /* The reader is a WinRM job waiting on this output to start connecting. */
  fflush(stdout);

  /* RpcShadow2 creates the shadow session in the target session on behalf of
     this caller. Printing the invitation and exiting leaves a listener that
     still completes an RDP handshake and then drops it, so hold the binding
     open to give an expert a window in which to connect. */
  unsigned long hold = hold_seconds(argc, argv);
  if (result == S_OK && hold > 0) {
    wprintf(L"holding the shadow session open for %lu seconds\n", hold);
    fflush(stdout);
    Sleep(hold * 1000);
  }

  RpcBindingFree(&binding);
  return result == S_OK ? 0 : (int)result;
}
