import { ChevronRight, FileText, Folder, FolderOpen, Image as ImageIcon } from 'lucide-react-native';
import { memo, useMemo, useState } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { HStack } from '@/components/ui/hstack';
import { Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { dirname, stripExtension, timeAgo } from '@/lib/paths';
import type { TreeNode } from '@/lib/types';

interface Row {
  node: TreeNode;
  depth: number;
  /** Folder path shown under a file when the list is filtered. */
  context?: string;
}

function flatten(tree: TreeNode, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.kind === 'dir' && expanded.has(n.path)) walk(n.children, depth + 1);
    }
  };
  if (tree.kind === 'dir') walk(tree.children, 0);
  return out;
}

function filtered(tree: TreeNode, query: string): Row[] {
  const q = query.trim().toLowerCase();
  const out: Row[] = [];
  const walk = (n: TreeNode) => {
    if (n.kind === 'dir') n.children.forEach(walk);
    else if (n.markdown && n.path.toLowerCase().includes(q)) out.push({ node: n, depth: 0, context: dirname(n.path) });
  };
  walk(tree);
  return out;
}

/** Folders worth opening by default: the root's, if there aren't many. */
function initialExpanded(tree: TreeNode): Set<string> {
  if (tree.kind !== 'dir') return new Set();
  const dirs = tree.children.filter((c) => c.kind === 'dir');
  return new Set(dirs.length <= 3 ? dirs.map((d) => d.path) : []);
}

interface Props {
  tree: TreeNode;
  query?: string;
  activePath?: string;
  onOpen(path: string): void;
  header?: React.ReactElement;
  refreshing?: boolean;
  onRefresh?(): void;
}

export function TreeView({ tree, query = '', activePath, onOpen, header, refreshing, onRefresh }: Props) {
  const [expanded, setExpanded] = useState(() => initialExpanded(tree));
  const rows = useMemo(
    () => (query.trim() ? filtered(tree, query) : flatten(tree, expanded)),
    [tree, expanded, query],
  );

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderItem: ListRenderItem<Row> = ({ item }) => (
    <TreeRow
      row={item}
      open={item.node.kind === 'dir' && expanded.has(item.node.path)}
      active={item.node.path === activePath}
      onPress={() => (item.node.kind === 'dir' ? toggle(item.node.path) : item.node.markdown && onOpen(item.node.path))}
    />
  );

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.node.path}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Text className="px-6 py-10 text-center text-muted-foreground">
          {query.trim() ? 'No file names match.' : 'No markdown files here.'}
        </Text>
      }
      contentContainerClassName="pb-10"
      keyboardShouldPersistTaps="handled"
      refreshing={refreshing}
      onRefresh={onRefresh}
      initialNumToRender={30}
    />
  );
}

const TreeRow = memo(function TreeRow({
  row,
  open,
  active,
  onPress,
}: {
  row: Row;
  open: boolean;
  active: boolean;
  onPress(): void;
}) {
  const { node, depth, context } = row;
  const isDir = node.kind === 'dir';
  const dim = node.kind === 'file' && !node.markdown;
  return (
    <Pressable
      onPress={onPress}
      disabled={dim}
      className={`mx-2 rounded-lg px-3 py-2.5 data-[active=true]:bg-muted ${active ? 'bg-accent' : ''}`}
      style={{ paddingLeft: 12 + depth * 18 }}
    >
      <HStack space="md" className="items-center">
        {isDir ? (
          <HStack space="xs" className="items-center">
            <Icon
              as={ChevronRight}
              size="sm"
              className="text-muted-foreground"
              style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
            />
            <Icon as={open ? FolderOpen : Folder} size="md" className="text-primary" />
          </HStack>
        ) : (
          <Icon
            as={dim ? ImageIcon : FileText}
            size="md"
            className={active ? 'text-accent-foreground' : 'text-muted-foreground'}
            style={{ marginLeft: 20 }}
          />
        )}
        <HStack className="flex-1 items-baseline justify-between" space="sm">
          <Text
            numberOfLines={1}
            className={`flex-1 ${isDir ? 'font-medium' : ''} ${dim ? 'text-muted-foreground' : ''} ${active ? 'font-semibold text-accent-foreground' : ''}`}
          >
            {isDir ? node.name : node.markdown ? stripExtension(node.name) : node.name}
            {context ? <Text className="text-muted-foreground">{`  ${context}`}</Text> : null}
          </Text>
          {node.kind === 'file' && node.mtime > 0 && !dim ? (
            <Text size="xs" className="text-muted-foreground">
              {timeAgo(node.mtime)}
            </Text>
          ) : null}
        </HStack>
      </HStack>
    </Pressable>
  );
});
