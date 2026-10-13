import { Stack, router, useLocalSearchParams } from 'expo-router';

import { DocReader } from '@/components/doc-reader';

export default function Read() {
  const { id, path, anchor, line } = useLocalSearchParams<{ id: string; path: string; anchor?: string; line?: string }>();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <DocReader
        sourceId={id}
        path={path}
        anchor={anchor}
        line={line ? Number(line) : undefined}
        safeTop
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onOpen={(next, nextAnchor) =>
          router.push({ pathname: '/source/[id]/read', params: { id, path: next, ...(nextAnchor ? { anchor: nextAnchor } : {}) } })
        }
      />
    </>
  );
}
