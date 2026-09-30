/*
 * Whether macOS answers ⌘Tab itself, or lets it through to the window in front.
 *
 * ⌘Tab is not an application's shortcut. The window server hands it to the Dock
 * before any application hears of it, so a full-screen desktop that wants it
 * for the far side's Alt+Tab never even sees the Tab: the page is told that ⌘
 * went down, and next that the window lost focus. ⌘C is different, and
 * reaches the application as a menu accelerator, which is why that one could
 * always be taken and this one could not.
 *
 * The window server keeps its own shortcuts as a numbered list, each of which
 * can be switched off by itself, and this switches off two: ⌘Tab and ⌘⇧Tab.
 * Nothing else. An earlier version turned off every system shortcut at once,
 * the way Parallels does, and took the screenshot keys and fn's change of
 * input source down with them.
 *
 * Nothing here needs Accessibility access, which matters for a build signed
 * ad-hoc: that permission is granted to a signature, and would have to be given
 * again after every update.
 *
 * The functions are private to the system, so they are looked up rather than
 * linked. A macOS that drops them costs ⌘Tab, not the application: `setEnabled`
 * answers false and the key stays with the system, as it always did.
 *
 * What they set outlives the process that set it — see `systemHotkeys.ts` in
 * the main process for how a crash is recovered from.
 *
 * The second half is the Mac's input language, which is public and needs none
 * of that: which language the selected layout types, and word when it changes.
 * A desktop is typed at in this Mac's layout, and its own layout is kept in step
 * from these — see `inputLanguage.ts` in the main process.
 */
#define NAPI_VERSION 8
#include <Carbon/Carbon.h>
#include <dlfcn.h>
#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/* CGSSymbolicHotKey. */
enum
{
	TD_COMMAND_TAB = 1,
	TD_COMMAND_SHIFT_TAB = 2
};

static const int TAKEN[] = { TD_COMMAND_TAB, TD_COMMAND_SHIFT_TAB };

typedef int td_error;
typedef td_error (*td_set_fn)(int, bool);
typedef bool (*td_is_fn)(int);

static td_set_fn set_hotkey;
static td_is_fn is_hotkey;

static void* find(void* image, const char* cgs, const char* sls)
{
	void* found = image ? dlsym(image, cgs) : NULL;
	if (!found)
		found = dlsym(RTLD_DEFAULT, cgs);
	/* SkyLight's own names, which the CoreGraphics ones have forwarded to
	   since 10.14. */
	if (!found)
		found = dlsym(RTLD_DEFAULT, sls);
	return found;
}

static bool resolve(void)
{
	static bool tried = false;
	if (!tried)
	{
		tried = true;
		void* graphics =
		    dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY);
		(void)dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
		set_hotkey = (td_set_fn)find(graphics, "CGSSetSymbolicHotKeyEnabled",
		                             "SLSSetSymbolicHotKeyEnabled");
		is_hotkey =
		    (td_is_fn)find(graphics, "CGSIsSymbolicHotKeyEnabled", "SLSIsSymbolicHotKeyEnabled");
	}
	return set_hotkey != NULL;
}

static napi_value boolean(napi_env env, bool value)
{
	napi_value result;
	napi_get_boolean(env, value, &result);
	return result;
}

/* available(): whether the switch exists on this system at all. */
static napi_value available(napi_env env, napi_callback_info info)
{
	(void)info;
	return boolean(env, resolve());
}

/* setEnabled(enabled): true when the window server took it for both. */
static napi_value set_enabled(napi_env env, napi_callback_info info)
{
	size_t argc = 1;
	napi_value argv[1];
	bool enabled = true;
	if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
	    napi_get_value_bool(env, argv[0], &enabled) != napi_ok)
	{
		napi_throw_type_error(env, NULL, "setEnabled takes a boolean");
		return NULL;
	}
	if (!resolve())
		return boolean(env, false);
	bool ok = true;
	for (size_t i = 0; i < sizeof TAKEN / sizeof TAKEN[0]; i++)
		ok = set_hotkey(TAKEN[i], enabled) == 0 && ok;
	return boolean(env, ok);
}

/* enabled(): whether macOS answers ⌘Tab now, or null if it cannot be asked. */
static napi_value enabled(napi_env env, napi_callback_info info)
{
	(void)info;
	if (!resolve() || !is_hotkey)
	{
		napi_value nothing;
		napi_get_null(env, &nothing);
		return nothing;
	}
	return boolean(env, is_hotkey(TD_COMMAND_TAB));
}

/* ------------------------------------------------------- the input language */

/*
 * The language the selected keyboard layout types, as its primary subtag: "en"
 * for ABC or U.S., "ru" for Russian. Written into `out`; false if there is none.
 */
static bool current_language(char* out, size_t size)
{
	TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
	if (!source)
		return false;
	bool found = false;
	CFArrayRef languages = TISGetInputSourceProperty(source, kTISPropertyInputSourceLanguages);
	if (languages && CFArrayGetCount(languages) > 0)
	{
		CFStringRef first = CFArrayGetValueAtIndex(languages, 0);
		found = CFStringGetCString(first, out, (CFIndex)size, kCFStringEncodingUTF8);
	}
	CFRelease(source);
	if (found)
	{
		/* "zh-Hans" and "en-GB" are Chinese and English here. */
		char* dash = strchr(out, '-');
		if (dash)
			*dash = '\0';
	}
	return found;
}

/* inputLanguage(): what `current_language` says, or null. */
static napi_value input_language(napi_env env, napi_callback_info info)
{
	(void)info;
	char language[32];
	napi_value result;
	if (current_language(language, sizeof language))
		napi_create_string_utf8(env, language, NAPI_AUTO_LENGTH, &result);
	else
		napi_get_null(env, &result);
	return result;
}

static napi_threadsafe_function language_listener;

static void deliver_language(napi_env env, napi_value callback, void* context, void* data)
{
	(void)context;
	char* language = data;
	if (env && callback)
	{
		napi_value text;
		napi_value global;
		napi_create_string_utf8(env, language, NAPI_AUTO_LENGTH, &text);
		napi_get_global(env, &global);
		napi_call_function(env, global, callback, 1, &text, NULL);
	}
	free(language);
}

static void language_changed(CFNotificationCenterRef center, void* observer, CFNotificationName name,
                             const void* object, CFDictionaryRef user_info)
{
	(void)center;
	(void)observer;
	(void)name;
	(void)object;
	(void)user_info;
	char language[32];
	if (!language_listener || !current_language(language, sizeof language))
		return;
	char* copy = strdup(language);
	if (napi_call_threadsafe_function(language_listener, copy, napi_tsfn_nonblocking) != napi_ok)
		free(copy);
}

/* onInputLanguage(callback): called with the new language whenever it changes. */
static napi_value on_input_language(napi_env env, napi_callback_info info)
{
	size_t argc = 1;
	napi_value argv[1];
	napi_valuetype type = napi_undefined;
	if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
	    napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function)
	{
		napi_throw_type_error(env, NULL, "onInputLanguage takes a function");
		return NULL;
	}
	const bool first = language_listener == NULL;
	if (!first)
		napi_release_threadsafe_function(language_listener, napi_tsfn_abort);
	napi_value name;
	napi_create_string_utf8(env, "td_hotkeys input language", NAPI_AUTO_LENGTH, &name);
	napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL,
	                                deliver_language, &language_listener);
	/* Word of a layout change is no reason to keep the process alive. */
	napi_unref_threadsafe_function(env, language_listener);
	if (first)
		CFNotificationCenterAddObserver(CFNotificationCenterGetDistributedCenter(), NULL,
		                                language_changed,
		                                kTISNotifySelectedKeyboardInputSourceChanged, NULL,
		                                CFNotificationSuspensionBehaviorDeliverImmediately);
	return NULL;
}

NAPI_MODULE_INIT()
{
	const napi_property_descriptor properties[] = {
		{ "available", NULL, available, NULL, NULL, NULL, napi_default, NULL },
		{ "setEnabled", NULL, set_enabled, NULL, NULL, NULL, napi_default, NULL },
		{ "enabled", NULL, enabled, NULL, NULL, NULL, napi_default, NULL },
		{ "inputLanguage", NULL, input_language, NULL, NULL, NULL, napi_default, NULL },
		{ "onInputLanguage", NULL, on_input_language, NULL, NULL, NULL, napi_default, NULL },
	};
	napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties);
	return exports;
}
