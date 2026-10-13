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

  // Latest callbacks, so a parent re-render never reloads the document.
  const cb = useRef({ onOpen, onToc, onProgress, onFind, onOffline });
  useEffect(() => {
    cb.current = { onOpen, onToc, onProgress, onFind, onOffline };
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
        call('render', {
          markdown: text,
          path,
          assetBase: source.assetBase(),
          keepPosition: opts.keepPosition && !firstTime,
          line: firstTime && !anchor ? (line ? Math.max(0, line - 1) : saved?.line) : undefined,
          anchor: firstTime ? anchor : undefined,
        });
        rendered.current = path;
        setState('ready');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      }
    },
    [source, path, anchor, line, call],
  );

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
        if (e.paths.includes(path)) {
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
          cb.current.onToc?.(msg.toc);
          break;
        case 'scroll':
          cb.current.onProgress?.(msg.progress);
          savePosition(source.id, path, { line: msg.line, progress: msg.progress });
          break;
        case 'link':
          if (isMarkdown(msg.path)) cb.current.onOpen(msg.path, msg.anchor);
          else notify('That file type opens on the laptop only.');
          break;
        case 'external':
          void Linking.openURL(msg.href).catch(() => notify("Couldn't open that link."));
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
    [call, load, notify, path, savePosition, source, theme],
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
              <Button variant="outline" onPress={() => void load()}>
                <ButtonText>Try again</ButtonText>
              </Button>
            </VStack>
          )}
        </View>
      )}
    </View>
  );
});
