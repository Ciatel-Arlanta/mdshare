import { Redirect, useLocalSearchParams } from 'expo-router';

import { addLocalFile } from '@/lib/local';
import { useStore } from '@/lib/store';

/** Entry point for "Open with mdshare" on a markdown file. */
export default function Open() {
  const { uri } = useLocalSearchParams<{ uri: string }>();
  if (!uri) return <Redirect href="/" />;
  const sourceId = addLocalFile(uri);
  const name = useStore.getState().files[sourceId.slice(2)]?.name ?? 'Document';
  return <Redirect href={{ pathname: '/source/[id]/read', params: { id: sourceId, path: name } }} />;
}
