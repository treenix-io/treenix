import { register } from '@treenx/core';
import { Render, useActions, useChildren, type View } from '@treenx/react';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View as RNView } from 'react-native';
import { TodoItem, TodoList } from './types';

const TodoListRN: View<TodoList> = ({ value, ctx }) => {
  const actions = useActions(value);
  const { data: children } = useChildren(ctx!.path, { watch: true, watchNew: true });
  const [draft, setDraft] = useState('');

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    await actions.add({ title: trimmed });
    setDraft('');
  };

  return (
    <RNView style={styles.container}>
      <Text style={styles.title}>{value.title ?? ''}</Text>

      <RNView style={styles.addRow}>
        <TextInput
          style={styles.input}
          placeholder="What needs to be done?"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={handleAdd}
          returnKeyType="done"
        />
        <Pressable style={styles.addButton} onPress={handleAdd}>
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </RNView>

      <ScrollView style={styles.list}>
        {children.map(child => (
          <Render key={child.$path} value={child} />
        ))}
      </ScrollView>
    </RNView>
  );
};

const TodoItemRN: View<TodoItem> = ({ value }) => {
  const actions = useActions(value);
  const done = value.done === true;

  return (
    <Pressable style={styles.row} onPress={() => actions.toggle()}>
      <RNView style={[styles.box, done && styles.boxDone]}>
        {done ? <Text style={styles.check}>✓</Text> : null}
      </RNView>
      <Text style={[styles.itemText, done && styles.itemTextDone]}>{value.title ?? ''}</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, maxWidth: 480, padding: 16, gap: 12, alignSelf: 'center', width: '100%' },
  title: { fontSize: 22, fontWeight: '700', color: '#111' },
  addRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    backgroundColor: 'white',
  },
  addButton: { paddingHorizontal: 14, justifyContent: 'center', backgroundColor: '#2563eb', borderRadius: 6 },
  addButtonText: { color: 'white', fontWeight: '600' },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  box: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#888',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxDone: { backgroundColor: '#22c55e', borderColor: '#22c55e' },
  check: { color: 'white', fontSize: 12, lineHeight: 12 },
  itemText: { fontSize: 16, color: '#111', flex: 1 },
  itemTextDone: { textDecorationLine: 'line-through', color: '#888' },
});

register(TodoList, 'react-native', TodoListRN);
register(TodoItem, 'react-native', TodoItemRN);
