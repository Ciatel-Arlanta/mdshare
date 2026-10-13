import { Stack, router, useLocalSearchParams } from 'expo-router';
import { CloudOff, FileText, QrCode, RefreshCw, Search, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, View, useWindowDimensions } from 'react-native';

import { DocReader } from '@/components/doc-reader';
import { useNotify } from '@/components/notify';
import { TreeView } from '@/components/tree-view';
import { Button, ButtonIcon, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Input, InputField, InputIcon, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { basename, dirname, stripExtension } from '@/lib/paths';
import { getSource, markdownFiles, useSourceStates } from '@/lib/sources';
import type { SearchHit, TreeNode } from '@/lib/types';

const SPLIT_WIDTH = 768;

function StatusBanner({ sourceId, offline }: { sourceId: string; offline: boolean }) {
  const state = useSourceStates((s) => s[sourceId]);
  if (!state || state.status === 'local') return null;
  if (state.status === 'unpaired') {
    return (
      <HStack space="md" className="mx-4 mb-2 items-center rounded-xl bg-destructive/10 p-3">
        <Text size="sm" className="flex-1 text-destructive">
          {state.error}
        </Text>
        <Button size="sm" variant="outline" onPress={() => router.push('/scan')}>
          <ButtonIcon as={QrCode} />
          <ButtonText>Pair again</ButtonText>
        </Button>
      </HStack>
    );
  }
  if (offline || state.status === 'offline') {
    return (
      <HStack space="sm" className="mx-4 mb-2 items-center rounded-xl bg-warning/10 p-3">
        <Icon as={CloudOff} size="sm" className="text-warning" />
        <Text size="sm" className="flex-1">
          Laptop isn’t sharing. Showing saved copies.
        </Text>
        <Button size="sm" variant="ghost" onPress={() => getSource(sourceId)?.refresh()}>
          <ButtonIcon as={RefreshCw} />
        </Button>
      </HStack>
    );
  }
  return (
    <HStack space="xs" className="items-center px-5 pb-2">
      <View className={`h-2 w-2 rounded-full ${state.live ? 'bg-success' : 'bg-muted-foreground/40'}`} />
      <Text size="xs" className="text-muted-foreground">
        {state.status === 'connecting'
          ? 'Connecting…'
          : state.live
            ? `Live · updates as files change · ${state.via}`
            : `Connected · ${state.via}`}
      </Text>
    </HStack>
  );
}

function SearchResults({ hits, onOpen }: { hits: SearchHit[]; onOpen(hit: SearchHit): void }) {
  return (
    <FlatList
      data={hits}
      keyExtractor={(h, i) => `${h.path}:${h.line}:${i}`}
      contentContainerClassName="pb-10"
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={<Text className="px-6 py-10 text-center text-muted-foreground">Nothing found.</Text>}
      renderItem={({ item }) => (
        <Pressable onPress={() => onOpen(item)} className="mx-2 rounded-lg px-3 py-2.5 data-[active=true]:bg-muted">
          <HStack space="md" className="items-start">
            <Icon as={FileText} size="md" className="mt-0.5 text-muted-foreground" />
            <VStack className="flex-1">
              <Text numberOfLines={1} className="font-medium">
                {stripExtension(basename(item.path))}
                {dirname(item.path) ? <Text className="text-muted-foreground">{`  ${dirname(item.path)}`}</Text> : null}
              </Text>
              {item.line > 0 ? (
                <Text size="sm" className="text-muted-foreground" numberOfLines={2}>
                  {`${item.line}: ${item.text}`}
                </Text>
              ) : null}
            </VStack>
          </HStack>
        </Pressable>
      )}
    />
  );
}

export default function Browse() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const source = getSource(id);
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_WIDTH;
  const splitRef = useRef(split);
  useEffect(() => {
    splitRef.current = split;
  }, [split]);
  const notify = useNotify();

  const [tree, setTree] = useState<TreeNode | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<{ path: string; anchor?: string; line?: number } | null>(null);

  const load = useCallback(
    (): Promise<void> =>
      source
        ? source.tree().then(
            (res) => {
              setTree(res.tree);
              setOffline(res.offline);
              setError('');
              // A single-file share opens straight into the reader on phones;
              // tablets show it in the reading pane via `shown` below.
              const entry = source.entry();
              if (entry && !splitRef.current) {
                router.replace({ pathname: '/source/[id]/read', params: { id, path: entry } });
              }
            },
            (e) => setError(e instanceof Error ? e.message : String(e)),
          )
        : Promise.resolve(),
    [source, id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Reload the tree when files are added or removed on the laptop.
  useEffect(() => source?.subscribe((e) => (e.tree || e.resync) && void load()), [source, load]);

  // Coming back online after being offline.
  const status = useSourceStates((s) => s[id]?.status);
  useEffect(() => {
    if (status === 'online' && offline) void load();
  }, [status, offline, load]);

  // On a tablet, show the README (or first document) until one is picked.
  const shown: { path: string; anchor?: string; line?: number } | null =
    selected ??
    (split && tree
      ? (() => {
          const files = markdownFiles(tree);
          const first = files.find((p) => /readme/i.test(p)) ?? files[0];
          return first ? { path: first } : null;
        })()
      : null);

  const open = (path: string, extra: { anchor?: string; line?: number } = {}) => {
    if (split) setSelected({ path, ...extra });
    else
      router.push({
        pathname: '/source/[id]/read',
        params: {
          id,
          path,
          ...(extra.anchor ? { anchor: extra.anchor } : {}),
          ...(extra.line ? { line: String(extra.line) } : {}),
        },
      });
  };

  const runSearch = async () => {
    if (!source || !query.trim()) return;
    setSearching(true);
    try {
      setHits(await source.search(query));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  if (!source) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <Stack.Screen options={{ title: 'Not found' }} />
        <Text className="text-muted-foreground">This laptop or folder was removed.</Text>
      </View>
    );
  }

  const searchBar = (
    <VStack space="sm" className="px-4 pb-2">
      <Input className="h-11 rounded-xl">
        <InputSlot className="pl-3">
          <InputIcon as={Search} className="text-muted-foreground" />
        </InputSlot>
        <InputField
          value={query}
          onChangeText={(q) => {
            setQuery(q);
            if (!q) setHits(null);
          }}
          placeholder="Filter files, or search inside them"
          returnKeyType="search"
          onSubmitEditing={() => void runSearch()}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {query ? (
          <InputSlot
            className="pr-3"
            onPress={() => {
              setQuery('');
              setHits(null);
            }}
          >
            <InputIcon as={X} className="text-muted-foreground" />
          </InputSlot>
        ) : null}
      </Input>
      {query.trim() && hits === null ? (
        <Button variant="outline" size="sm" className="self-start rounded-full" onPress={() => void runSearch()}>
          {searching ? <ButtonSpinner /> : <ButtonIcon as={Search} />}
          <ButtonText>{`Search inside files for “${query.trim()}”`}</ButtonText>
        </Button>
      ) : null}
    </VStack>
  );

  const list = (
    <View className="flex-1">
      <StatusBanner sourceId={id} offline={offline} />
      {searchBar}
      {!tree ? (
        error ? (
          <VStack space="md" className="items-center p-8">
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
        ) : (
          <VStack space="md" className="p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-6 rounded-md" style={{ width: `${80 - i * 9}%` }} />
            ))}
          </VStack>
        )
      ) : hits ? (
        <SearchResults hits={hits} onOpen={(h) => open(h.path, { line: h.line || undefined })} />
      ) : (
        <TreeView
          tree={tree}
          query={query}
          activePath={split ? shown?.path : undefined}
          onOpen={(p) => open(p)}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            source.refresh();
            await load();
            setRefreshing(false);
          }}
        />
      )}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: source.title() }} />
      {split ? (
        <HStack className="flex-1">
          <View className="w-80 border-r border-border">{list}</View>
          <View className="flex-1">
            {shown ? (
              <DocReader
                key={shown.path}
                sourceId={id}
                path={shown.path}
                anchor={shown.anchor}
                line={shown.line}
                onOpen={(path, anchor) => setSelected({ path, anchor })}
              />
            ) : (
              <View className="flex-1 items-center justify-center">
                <Text className="text-muted-foreground">Pick a document</Text>
              </View>
            )}
          </View>
        </HStack>
      ) : (
        list
      )}
    </>
  );
}
