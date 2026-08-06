import type { HttpModeConfig, ScreenshotMode } from '@vyzus/shared';
import { SCREENSHOT_MODES } from '@vyzus/shared';
import { inputClass, labelClass } from './formFields';

// The raw enum values are terse ("on_change"); spell out what each one costs
// in stored files so the choice is obvious at the point of decision.
const SCREENSHOT_MODE_LABEL: Record<ScreenshotMode, string> = {
  always: 'Every run',
  on_change: 'On failure and recovery',
  on_failure: 'On failure only',
  never: 'Never (button only)',
};

const SCREENSHOT_MODE_HINT: Record<ScreenshotMode, string> = {
  always: 'A capture on every scheduled run. Consecutive runs with the same outcome still collapse to one stored file.',
  on_change:
    'Captures the failure, and again on the first run that passes afterwards, so you see both what broke and what it looked like once it came back.',
  on_failure: 'Captures failures only. A recovery leaves the last failure screenshot in place.',
  never: 'No automatic captures. The Screenshot button still works at any time.',
};

export function HttpModeConfigFields({
  config,
  onChange,
}: {
  config: HttpModeConfig;
  onChange: (config: HttpModeConfig) => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="expectedStatus" className={labelClass}>
          Expected HTTP status
        </label>
        <input
          id="expectedStatus"
          type="number"
          min={100}
          max={599}
          value={config.expectedStatus}
          onChange={(e) => onChange({ ...config, expectedStatus: Number(e.target.value) })}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="selector" className={labelClass}>
          CSS selector present (optional)
        </label>
        <input
          id="selector"
          value={config.selector ?? ''}
          onChange={(e) => onChange({ ...config, selector: e.target.value || undefined })}
          className={inputClass}
          placeholder="#app-root"
        />
      </div>
      <div>
        <label htmlFor="bodyText" className={labelClass}>
          Text present on page (optional)
        </label>
        <input
          id="bodyText"
          value={config.bodyText ?? ''}
          onChange={(e) => onChange({ ...config, bodyText: e.target.value || undefined })}
          className={inputClass}
          placeholder="Welcome back"
        />
      </div>
      <div>
        <label htmlFor="title" className={labelClass}>
          Page title contains (optional)
        </label>
        <input
          id="title"
          value={config.title ?? ''}
          onChange={(e) => onChange({ ...config, title: e.target.value || undefined })}
          className={inputClass}
          placeholder="Paste the landing page's <title> here"
        />
        <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
          Fails the check if the page's title ever stops containing this — catches a maintenance page, a misconfigured
          deploy, or a hijacked domain even when the site still returns 200.
        </p>
      </div>
      <div>
        <label htmlFor="screenshot" className={labelClass}>
          Screenshot
        </label>
        <select
          id="screenshot"
          value={config.screenshot}
          onChange={(e) => onChange({ ...config, screenshot: e.target.value as HttpModeConfig['screenshot'] })}
          className={inputClass}
        >
          {SCREENSHOT_MODES.map((m) => (
            <option key={m} value={m}>
              {SCREENSHOT_MODE_LABEL[m]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">{SCREENSHOT_MODE_HINT[config.screenshot]}</p>
      </div>

      {/* Periodic refresh only means something when captures are otherwise
          event-driven; `always` already shoots every run and `never` shoots
          none, so the field would be a no-op for both. */}
      {(config.screenshot === 'on_change' || config.screenshot === 'on_failure') && (
        <div>
          <label htmlFor="screenshotRefresh" className={labelClass}>
            Also refresh while healthy
          </label>
          <div className="flex items-center gap-2">
            <input
              id="screenshotRefresh"
              type="number"
              min={1}
              max={10080}
              placeholder="off"
              value={config.screenshotRefreshMinutes ?? ''}
              onChange={(e) =>
                onChange({
                  ...config,
                  screenshotRefreshMinutes: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              className={`${inputClass} max-w-32`}
            />
            <span className="text-sm text-slate-500 dark:text-zinc-400">minutes</span>
          </div>
          <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
            On a passing run, refresh the stored screenshot once the current one is older than this, so a healthy check
            still shows the site as it looks today. Leave empty to only capture on failure
            {config.screenshot === 'on_change' ? ' and recovery' : ''}.
          </p>
        </div>
      )}
    </div>
  );
}
