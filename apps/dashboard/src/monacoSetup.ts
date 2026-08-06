// Bundle Monaco locally and point @monaco-editor/react's loader at it, instead
// of its default behavior of fetching monaco from a CDN at runtime. This app is
// meant to run fully self-hosted (docs/01-requirements.md NFR-6 — no cloud
// dependencies) and CDN fetches silently hang the editor on any network that
// can't reach it (corporate proxy, air-gapped host, ad-blocker).
//
// Imported only from JourneyConfigFields (itself reachable solely through the
// lazy-loaded CheckEditor route) so this — and Monaco's ~1 MB core — never
// lands in the app's main entry chunk. Only the editor core + TypeScript
// language service are pulled in (not `monaco-editor`'s full barrel, which
// registers every language Monaco supports and would bloat the chunk further).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TypescriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TypescriptWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
