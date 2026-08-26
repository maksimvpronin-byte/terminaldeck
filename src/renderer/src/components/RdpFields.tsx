import type {
  RdpDefaults,
  RdpResolution,
  ResolvedRdp,
} from "../../../shared/types";
import { useT } from "../i18n";

interface Props {
  value: RdpDefaults;
  set: <K extends keyof RdpDefaults>(key: K, value: RdpDefaults[K]) => void;
  /** What this item ends up connecting with once its own values are applied. */
  effective: ResolvedRdp;
  /** Where a blank field's value comes from, e.g. "inherited from Prod". */
  inheritedFrom: (key: keyof RdpDefaults) => string;
  /** Only offered when there is something above to inherit from. */
  inheritToggle?: { label: string };
  /**
   * The gateway password, typed here and stored by whoever owns the dialog —
   * the same contract the login password already uses, since a secret must not
   * be held in a value the component renders from a second time.
   */
  secret: {
    typed: string;
    onTyped: (value: string) => void;
    own: boolean;
    forget: boolean;
    onForget: (forget: boolean) => void;
  };
}

/**
 * The desktop half of a session, a group or an inventory override: how a host
 * is reached, how big its screen is, and what the ⌘ key does over it.
 *
 * Every control offers inheritance, so a gateway shared by a whole floor of
 * machines is stated once on the group and left blank on each host.
 */
export default function RdpFields({
  value,
  set,
  effective,
  inheritedFrom,
  inheritToggle,
  secret,
}: Props): JSX.Element {
  const t = useT();

  return (
    <>
      {inheritToggle && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={value.inheritRdp !== false}
            onChange={(e) =>
              set("inheritRdp", e.target.checked ? undefined : false)
            }
          />
          {inheritToggle.label}
        </label>
      )}

      <p className="settings-note">
        {t(
          "A gateway says where a machine lives rather than who you are on it, so it is usually stated once on a group and left blank below. Blank reaches the host directly.",
        )}
      </p>

      <div className="form-row">
        <label style={{ flex: 3 }}>
          {t("RD Gateway")}
          <input
            value={value.gatewayHost ?? ""}
            placeholder={
              inheritedFrom("gatewayHost") || t("none — connect directly")
            }
            onChange={(e) => set("gatewayHost", e.target.value || undefined)}
          />
        </label>
        <label style={{ flex: 1 }}>
          {t("Port")}
          <input
            type="number"
            value={value.gatewayPort ?? ""}
            placeholder={String(effective.gatewayPort)}
            onChange={(e) =>
              set(
                "gatewayPort",
                e.target.value ? Number(e.target.value) : undefined,
              )
            }
          />
        </label>
      </div>

      {effective.gatewayHost && (
        <>
          <div className="form-row">
            <label style={{ flex: 1 }}>
              {t("Gateway username")}
              <input
                value={value.gatewayUsername ?? ""}
                placeholder={
                  inheritedFrom("gatewayUsername") || t("the host's own login")
                }
                onChange={(e) =>
                  set("gatewayUsername", e.target.value || undefined)
                }
              />
            </label>
            <label style={{ flex: 1 }}>
              {t("Gateway password")}
              <input
                type="password"
                value={secret.typed}
                placeholder={
                  secret.own && !secret.forget
                    ? t("(saved here)")
                    : t("(blank uses the host's own)")
                }
                onChange={(e) => secret.onTyped(e.target.value)}
              />
            </label>
          </div>

          {secret.own && (
            <p className="settings-note">
              {secret.forget
                ? t("On save the gateway password stored here is forgotten.")
                : t(
                    "A gateway password is stored here, and the nearest value wins.",
                  )}{" "}
              <button
                type="button"
                onClick={() => secret.onForget(!secret.forget)}
              >
                {secret.forget ? t("Keep it") : t("Forget it")}
              </button>
            </p>
          )}

          <label className="checkbox-row" style={{ flexDirection: "row" }}>
            <input
              type="checkbox"
              checked={effective.gatewayBypassLocal}
              onChange={(e) => set("gatewayBypassLocal", e.target.checked)}
            />
            {t("Reach private addresses directly, without the gateway")}
          </label>
        </>
      )}

      <div className="form-row">
        <label style={{ flex: 1 }}>
          {t("Resolution")}
          <select
            value={value.resolution ?? ""}
            onChange={(e) =>
              set("resolution", (e.target.value || undefined) as RdpResolution)
            }
          >
            <option value="">
              {t("Inherit")} (
              {inheritedFrom("resolution") ? effective.resolution : "fit"})
            </option>
            <option value="fit">{t("Fit the pane")}</option>
            <option value="fixed">{t("Fixed size")}</option>
          </select>
        </label>
      </div>

      {effective.resolution === "fixed" && (
        <div className="form-row">
          <label style={{ flex: 1 }}>
            {t("Width")}
            <input
              type="number"
              value={value.desktopWidth ?? ""}
              placeholder={String(effective.desktopWidth)}
              onChange={(e) =>
                set(
                  "desktopWidth",
                  e.target.value ? Number(e.target.value) : undefined,
                )
              }
            />
          </label>
          <label style={{ flex: 1 }}>
            {t("Height")}
            <input
              type="number"
              value={value.desktopHeight ?? ""}
              placeholder={String(effective.desktopHeight)}
              onChange={(e) =>
                set(
                  "desktopHeight",
                  e.target.value ? Number(e.target.value) : undefined,
                )
              }
            />
          </label>
        </div>
      )}
      <p className="settings-note">
        {effective.resolution === "fixed"
          ? t("The desktop keeps this size and is scaled into the pane.")
          : t(
              "The far end is asked to match the pane whenever it is resized, so every pixel stays its own.",
            )}
      </p>

      <label>
        {t("Most pixels to ask for")}
        <select
          value={String(effective.pixelBudget)}
          onChange={(e) => set("pixelBudget", Number(e.target.value))}
        >
          <option value="1.5">{t("Fewest — a slow link")}</option>
          <option value="3.5">{t("Balanced")}</option>
          <option value="100">{t("As many as the screen has")}</option>
        </select>
      </label>
      <p className="settings-note">
        {t(
          "The size is counted in the screen's own pixels rather than the pane's points, so a desktop can be drawn sharper than the pane is wide. On a display with one pixel per point — every ordinary monitor — that is exactly the pane and this setting changes nothing. On a Retina display, magnified as little as the setting below allows, it is up to four times the data: past this budget the desktop is asked for less than was wanted rather than the largest size.",
        )}
      </p>

      <label className="checkbox-row" style={{ flexDirection: "row" }}>
        <input
          type="checkbox"
          checked={effective.sendDensity}
          onChange={(e) => set("sendDensity", e.target.checked)}
        />
        {t("Tell the session how dense this display is")}
      </label>
      <p className="settings-note">
        {t(
          "Then the far end draws its own interface larger instead of the picture being stretched here, which is the same size at full sharpness — and the only way to get it. DPI is agreed per connection rather than written into the machine, and only a session of this app's own is ever told: a session someone else is logged on to is never resized at all. Windows 8.1 and Server 2012 R2 and later act on it; anything older ignores it and the desktop stays as it was, so the setting below is what to fall back on. With the budget above at everything the screen has, this is a desktop drawn pixel for pixel.",
        )}
      </p>

      <label style={{ opacity: effective.sendDensity ? 0.5 : 1 }}>
        {t("How much larger the picture is drawn")}
        <select
          disabled={effective.sendDensity}
          value={
            value.magnification === undefined ? "" : String(value.magnification)
          }
          onChange={(e) =>
            set(
              "magnification",
              e.target.value === "" ? undefined : Number(e.target.value),
            )
          }
        >
          <option value="">
            {t("Inherit")} (
            {effective.magnification
              ? `${effective.magnification}%`
              : t("as much as this display")}
            )
          </option>
          <option value="0">{t("As much as this display")}</option>
          <option value="100">{t("Not at all — every pixel its own")}</option>
          <option value="125">125%</option>
          <option value="150">150%</option>
          <option value="200">200%</option>
          <option value="300">300%</option>
        </select>
      </label>
      <p className="settings-note">
        {t(
          "Pixels and size are different questions, and the budget above only answers the first. Windows lays out a 20-pixel menu the same way whether a pixel is a millimetre across or half of one, so a desktop drawn sharp on a Retina display is also drawn half the size an ordinary monitor gives it. A smaller desktop drawn larger is the answer this end can give on its own: nothing about the far machine is changed, and a session someone else is logged on to is not resized under them. Following the display asks a Retina pane for exactly its own points and draws every pixel as four — the usual size, and a softer picture than the display could hold.",
        )}
      </p>

      <label className="checkbox-row" style={{ flexDirection: "row" }}>
        <input
          type="checkbox"
          checked={effective.commandAsControl}
          onChange={(e) => set("commandAsControl", e.target.checked)}
        />
        {t("Send ⌘ as Ctrl")}
      </label>
      <p className="settings-note">
        {t(
          "Copy and paste then land where they do on Windows. While the desktop has the keyboard this app's own ⌘ shortcuts do not fire; ⌘Q and ⌘Tab still belong to macOS.",
        )}
      </p>
    </>
  );
}
