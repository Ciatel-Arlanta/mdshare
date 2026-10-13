import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { ArrowLeft, ChevronDown, ChevronUp, CloudOff, List, Search, Type, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, ButtonIcon } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Input, InputField } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { basename, stripExtension } from '@/lib/paths';
import { getSource, useSourceStates } from '@/lib/sources';
import { useStore } from '@/lib/store';

import { ReaderView, type ReaderHandle, type TocItem } from './reader-view';
import { AppearanceSheet, TocSheet } from './sheets';

interface Props {
  sourceId: string;
  path: string;
  anchor?: string;
  line?: number;
  /** Shows a back arrow when set. */
  onBack?(): void;
  onOpen(path: string, anchor?: string): void;
  /** Pad the top bar for the status bar (full-screen reader). */
  safeTop?: boolean;
}

function ToolButton({ icon, label, onPress }: { icon: typeof List; label: string; onPress(): void }) {
  return (
    <Button variant="ghost" size="icon" className="h-11 w-11 rounded-full" onPress={onPress} accessibilityLabel={label}>
      <ButtonIcon as={icon} className="h-[22px] w-[22px]" />
    </Button>
  );
}

export function DocReader({ sourceId, path, anchor, line, onBack, onOpen, safeTop }: Props) {
  const source = getSource(sourceId);
  const state = useSourceStates((s) => s[sourceId]);
  const keepScreenOn = useStore((s) => s.prefs.keepScreenOn);
  const touchRecent = useStore((s) => s.touchRecent);
  const insets = useSafeAreaInsets();
  const reader = useRef<ReaderHandle>(null);

  const [toc, setToc] = useState<TocItem[]>([]);
  const [progress, setProgress] = useState(0);
  const [offline, setOffline] = useState(false);
  const [sheet, setSheet] = useState<'toc' | 'appearance' | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState({ current: 0, total: 0 });

  const title = stripExtension(basename(path));

  useEffect(() => {
    touchRecent({ sourceId, path, title });
  }, [sourceId, path, title, touchRecent]);

  useEffect(() => {
    if (!keepScreenOn) return;
    void activateKeepAwakeAsync('reader');
    return () => {
      void deactivateKeepAwake('reader');
    };
  }, [keepScreenOn]);

  if (!source) {
    return (
      <View style={{ paddingTop: safeTop ? insets.top : 0 }} className="flex-1 bg-background">
        {onBack ? (
          <HStack className="h-14 items-center px-1">
            <ToolButton icon={ArrowLeft} label="Back" onPress={onBack} />
          </HStack>
        ) : null}
        <View className="flex-1 items-center justify-center p-8">
          <Text className="text-center text-muted-foreground">
            This laptop or folder was removed, so the document isn’t available any more.
          </Text>
        </View>
      </View>
    );
  }

  const subtitle = offline
    ? 'Saved copy'
    : state?.live
      ? `Live · ${source.title()}`
      : source.title();

  const closeFind = () => {
    setFinding(false);
    setQuery('');
    setFound({ current: 0, total: 0 });
    reader.current?.clearFind();
  };

  return (
    <View className="flex-1 bg-background">
      <View style={{ paddingTop: safeTop ? insets.top : 0 }} className="border-b border-border bg-background">
        {finding ? (
          <HStack space="xs" className="h-14 items-center px-1">
            <ToolButton icon={X} label="Close search" onPress={closeFind} />
            <Input className="h-10 flex-1 rounded-full">
              <InputField
                value={query}
                onChangeText={(q) => {
                  setQuery(q);
                  reader.current?.find(q);
                }}
                placeholder="Find in document"
                autoFocus
                returnKeyType="search"
                onSubmitEditing={() => reader.current?.findStep(1)}
              />
            </Input>
            <Text size="sm" className="min-w-12 text-center text-muted-foreground">
              {query ? `${found.current}/${found.total}` : ''}
            </Text>
            <ToolButton icon={ChevronUp} label="Previous match" onPress={() => reader.current?.findStep(-1)} />
            <ToolButton icon={ChevronDown} label="Next match" onPress={() => reader.current?.findStep(1)} />
          </HStack>
        ) : (
          <HStack className="h-14 items-center px-1">
            {onBack ? <ToolButton icon={ArrowLeft} label="Back" onPress={onBack} /> : <View className="w-3" />}
            <VStack className="flex-1 px-1">
              <Text className="font-semibold" numberOfLines={1}>
                {title}
              </Text>
              <HStack space="xs" className="items-center">
                {offline ? <Icon as={CloudOff} size="2xs" className="text-warning" /> : null}
                {state?.live && !offline ? <View className="h-1.5 w-1.5 rounded-full bg-success" /> : null}
                <Text size="xs" className="text-muted-foreground" numberOfLines={1}>
                  {subtitle}
                </Text>
              </HStack>
            </VStack>
            <ToolButton icon={Search} label="Find in document" onPress={() => setFinding(true)} />
            <ToolButton icon={List} label="Contents" onPress={() => setSheet('toc')} />
            <ToolButton icon={Type} label="Reading settings" onPress={() => setSheet('appearance')} />
          </HStack>
        )}
        <View className="h-0.5 bg-transparent">
          <View className="h-0.5 bg-primary" style={{ width: `${Math.round(progress * 100)}%` }} />
        </View>
      </View>

      <ReaderView
        ref={reader}
        source={source}
        path={path}
        anchor={anchor}
        line={line}
        onOpen={onOpen}
        onToc={setToc}
        onProgress={setProgress}
        onOffline={setOffline}
        onFind={(current, total) => setFound({ current, total })}
      />

      <TocSheet
        isOpen={sheet === 'toc'}
        onClose={() => setSheet(null)}
        items={toc}
        onPick={(id) => reader.current?.scrollToId(id)}
      />
      <AppearanceSheet isOpen={sheet === 'appearance'} onClose={() => setSheet(null)} />
    </View>
  );
}
