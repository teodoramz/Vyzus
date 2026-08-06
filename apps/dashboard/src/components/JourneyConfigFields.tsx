// FR-2.3/FR-4.5 journey spec editor: Monaco with TypeScript syntax
// highlighting. Users record locally with `npx playwright codegen <url>` and
// paste the resulting steps here; the worker wraps it in its own runner
// harness (02-architecture §5.2) — this editor only edits `specSource` text.
import Editor from '@monaco-editor/react';
import type { JourneyConfig } from '@vyzus/shared';
import { JOURNEY_SPEC_MAX_BYTES } from '@vyzus/shared';
import { useDarkModeValue } from '../hooks/useDarkModeValue';
import '../monacoSetup';

// The real default value for a new journey check's specSource (not a Monaco
// "placeholder" overlay — Monaco has no such concept, and faking one by
// showing this text only via the `value` prop while leaving state as ''
// silently sends an empty specSource on save/dry-run the moment a user
// doesn't touch the editor first). Steps only — no function wrapper: the
// worker's sandbox already wraps whatever is here in its own
// `export default async ({ page, context, expect }) => { ... }`
// (02-architecture §5.2), so `page`/`context`/`expect` are already in scope.
export const DEFAULT_JOURNEY_SPEC = `// Record locally with: npx playwright codegen <url>, then paste the
// generated steps below (just the steps — no function wrapper, no imports).
await page.goto('https://example.com');
await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
`;

export function JourneyConfigFields({
  config,
  onChange,
}: {
  config: JourneyConfig;
  onChange: (config: JourneyConfig) => void;
}): JSX.Element {
  const dark = useDarkModeValue();
  const bytes = new TextEncoder().encode(config.specSource).length;
  const overLimit = bytes > JOURNEY_SPEC_MAX_BYTES;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600 dark:text-zinc-400">Journey spec</span>
        <span
          className={`text-xs tabular ${overLimit ? 'text-red-600 dark:text-rose-500' : 'text-slate-400 dark:text-zinc-500'}`}
        >
          {(bytes / 1024).toFixed(1)} / {(JOURNEY_SPEC_MAX_BYTES / 1024).toFixed(0)} KB
        </span>
      </div>
      <div className="monaco-wrapper overflow-hidden rounded border border-gray-200 dark:border-white/10">
        <Editor
          height="420px"
          language="typescript"
          theme={dark ? 'vs-dark' : 'light'}
          value={config.specSource}
          onChange={(value) => onChange({ specSource: value ?? '' })}
          options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on' }}
          loading={
            <div className="flex h-full items-center justify-center text-sm text-slate-400 dark:text-zinc-500">
              Loading editor…
            </div>
          }
        />
      </div>
      {overLimit && <p className="text-xs text-red-600 dark:text-rose-500">Spec exceeds the 64 KB limit.</p>}
    </div>
  );
}
