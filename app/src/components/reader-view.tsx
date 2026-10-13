import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Button, ButtonText } from '@/components/ui/button';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { isMarkdown } from '@/lib/paths';
import type { Source } from '@/lib/sources';
import { docKey, useStore } from '@/lib/store';
import { READER_BACKGROUND, useReaderTheme } from '@/lib/theme';

import { useNotify } from './notify';

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

export interface ReaderHandle {
  scrollToId(id: string): void;
  find(query: string): void;
  findStep(step: 1 | -1): void;
  clearFind(): void;
}

interface Props {
  source: Source;
  path: string;
  anchor?: string;
  /** Source line to open at (a search hit); overrides the saved position. */
  line?: number;
  /** A link to another markdown file in the same source was tapped. */
  onOpen(path: string, anchor?: string): void;
  onToc?(items: TocItem[]): void;
  onProgress?(progress: number): void;
  onFind?(current: number, total: number): void;
  /** The document came from the offline copy. */
  onOffline?(offline: boolean): void;
}

type Msg =
  | { type: 'ready' }
  | { type: 'rendered'; toc: TocItem[]; words: number }
  | { type: 'scroll'; line: number; progress: number }
  | { type: 'link'; path: string; anchor?: string }
  | { type: 'external'; href: string }
  | { type: 'asset'; path: string }
  | { type: 'copy'; text: string }
  | { type: 'image'; src: string }
  | { type: 'find'; current: number; total: number };

const READER_URL =
  Platform.OS === 'android' ? 'file:///android_asset/reader/index.html' : 'reader/index.html';

export const ReaderView = forwardRef<ReaderHandle, Props>(function ReaderView(
  { source, path, anchor, line, onOpen, onToc, onProgress, onFind, onOffline },
  ref,
) {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const rendered = useRef<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const notify = useNotify();

  // Latest callbacks and jump targets, so a parent re-render never reloads
  // the document.
  const cb = useRef({ onOpen, onToc, onProgress, onFind, onOffline });
  const nav = useRef({ anchor, line });
  useEffect(() => {
    cb.current = { onOpen, onToc, onProgress, onFind, onOffline };
    nav.current = { anchor, line };
  });

  const prefs = useStore((s) => s.prefs);
  const theme = useReaderTheme();
  const savePosition = useStore((s) => s.savePosition);

  const run = useCallback((js: string) => {
    web.current?.injectJavaScript(`${js};true;`);
  }, []);

  const call = useCallback(
    (fn: string, ...args: unknown[]) => run(`window.mdshare && window.mdshare.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`),
    [run],
  );

  useImperativeHandle(ref, () => ({
    scrollToId: (id) => call('scrollToId', id),
    find: (q) => call('find', q, 0),
    findStep: (step) => call('find', '', step),
    clearFind: () => call('clearFind'),
  }));

  const load = useCallback(
    async (opts: { keepPosition?: boolean } = {}) => {
      if (!ready.current) return;
      if (!opts.keepPosition) setState('loading');
      try {
        const { text, offline } = await source.read(path);
        cb.current.onOffline?.(offline);
        const saved = useStore.getState().positions[docKey(source.id, path)];
        const firstTime = rendered.current !== path;
        const { anchor: target, line: hit } = nav.current;
        // The overlay goes away when the page reports `rendered`.
        call('render', {
          markdown: text,
          path,
          assetBase: source.assetBase(),
          keepPosition: opts.keepPosition && !firstTime,
          line: firstTime && !target ? (hit ? Math.max(0, hit - 1) : saved?.line) : undefined,
          anchor: firstTime ? target : undefined,
        });
        rendered.current = path;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      }
    },
    [source, path, call],
  );

  // A new jump target for the document already on screen (a search hit or
  // heading link in the tablet layout): scroll instead of re-rendering.
  useEffect(() => {
    if (!ready.current || rendered.current !== path) return;
    if (anchor) call('scrollToId', anchor);
    else if (line) call('scrollToLine', Math.max(0, line - 1));
  }, [anchor, line, path, call]);

  // Reading position: keep the latest in memory and persist it at most every
  // couple of seconds (and when leaving), not on every scroll event.
  const position = useRef<{ line: number; progress: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPosition = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (position.current) savePosition(source.id, path, position.current);
  }, [savePosition, source.id, path]);
  useEffect(() => flushPosition, [flushPosition]);

  // Push preferences into the page whenever they change.
  useEffect(() => {
    if (!ready.current) return;
    call('setPrefs', {
      theme,
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      width: prefs.width,
      font: prefs.font,
    });
  }, [call, theme, prefs.fontSize, prefs.lineHeight, prefs.width, prefs.font]);

  // A new path in the same WebView.
  useEffect(() => {
    void load();
  }, [load]);

  // Live reload.
  useEffect(
    () =>
      source.subscribe((e) => {
        if (e.resync || e.paths.includes(path)) {
          void load({ keepPosition: true });
        }
      }),
    [source, path, load],
  );

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let msg: Msg;
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready': {
          ready.current = true;
          const p = useStore.getState().prefs;
          call('setPrefs', { theme, fontSize: p.fontSize, lineHeight: p.lineHeight, width: p.width, font: p.font });
          void load();
          break;
        }
        case 'rendered':
          setState('ready');
          cb.current.onToc?.(msg.toc);
          break;
        case 'scroll':
          cb.current.onProgress?.(msg.progress);
          position.current = { line: msg.line, progress: msg.progress };
          saveTimer.current ??= setTimeout(flushPosition, 2000);
          break;
        case 'link':
          if (isMarkdown(msg.path)) cb.current.onOpen(msg.path, msg.anchor);
          else notify('That file type opens on the laptop only.');
          break;
        case 'external':
          // Only web and mail links; never intent:, content: or file: URIs
          // that a document could use to poke other apps.
          if (/^(https?|mailto):/i.test(msg.href.trim())) {
            void Linking.openURL(msg.href).catch(() => notify("Couldn't open that link."));
          } else {
            notify('That kind of link can’t be opened from a document.');
          }
          break;
        case 'asset': {
          const url = await source.asset(msg.path);
          if (url) call('assetResolved', msg.path, url);
          break;
        }
        case 'copy':
          await Clipboard.setStringAsync(msg.text);
          break;
        case 'find':
          cb.current.onFind?.(msg.current, msg.total);
          break;
      }
    },
    [call, load, notify, flushPosition, source, theme],
  );

  const background = READER_BACKGROUND[theme];

  return (
    <View style={{ flex: 1, backgroundColor: background }}>
      <WebView
        ref={web}
        source={{ uri: READER_URL }}
        originWhitelist={['file://*']}
        allowFileAccess
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="always"
        textZoom={100}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req) => req.url.startsWith('file:///android_asset/reader/') || req.url === 'about:blank'}
        onMessage={onMessage}
        onContentProcessDidTerminate={() => web.current?.reload()}
        onRenderProcessGone={() => web.current?.reload()}
        onLoadStart={() => {
          ready.current = false;
          rendered.current = null;
        }}
        style={{ flex: 1, backgroundColor: background }}
        webviewDebuggingEnabled={__DEV__}
      />
      {state !== 'ready' && (
        <View className="absolute inset-0 bg-background" style={{ backgroundColor: background }}>
          {state === 'loading' ? (
            <VStack space="lg" className="p-5">
              <Skeleton className="h-8 w-3/4 rounded-md" />
              <SkeletonText _lines={4} className="h-3" />
              <SkeletonText _lines={3} className="h-3" />
            </VStack>
          ) : (
            <VStack space="md" className="flex-1 items-center justify-center p-8">
              <Text className="text-center text-muted-foreground">{error}</Text>
              <Button
                variant="outline"
                onPress={() => {
                  source.refresh();
                  void load();
                }}
              >
                <ButtonText>Try again</ButtonText>
              </Button>
            </VStack>
          )}
        </View>
      )}
    </View>
  );
});
