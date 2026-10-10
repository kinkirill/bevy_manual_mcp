import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BevyIndex } from '../src/store.js';
import { fixtureRecord } from './helpers.mjs';
import type { DocExample } from '../src/types.js';

const example: DocExample = { lang: 'rust', code: 'let widget = Widget::new();', compile_fail: false, ignored: false, scraped: false, source_file: null };
function record(docs: string) {
  return fixtureRecord({ source: 'rustdoc', kind: 'struct', name: 'Widget', full_path: 'bevy::Widget',
    module: 'bevy', docs, signature: 'pub struct Widget;', bevy_version: '0.20.0' });
}

await test('duplicate published API rows retain their richer docs and unique examples', async () => {
  const index = new BevyIndex();
  const first = record('A documented widget with a quasar identifier.');
  first.examples = [example];
  const sparse = record('');
  sparse.examples = [example];
  index.addRecords([first, sparse]);
  assert.equal(index.records.length, 1);
  assert.equal(index.byId.get(first.id!)?.docs, first.docs);
  assert.deepEqual(index.records[0]?.examples, [example]);
  assert.ok(index.repairedIds.has(first.id!));
  index.buildSymbolTable();
  await index.buildTextIndex();
  assert.equal(index.searchText('quasar')[0]?.record.docs, first.docs);
});

await test('a later richer row enriches the existing record used by resources', () => {
  const index = new BevyIndex();
  const sparse = record('');
  const rich = record('Complete documentation.');
  rich.source_ref = 'https://docs.rs/bevy_widget/0.20.0/src/bevy_widget/lib.rs.html';
  rich.defaults = 'Widget::default()';
  index.addRecords([sparse, rich]);
  assert.equal(index.records[0]?.docs, rich.docs);
  assert.equal(index.records[0]?.source_ref, rich.source_ref);
  assert.equal(index.records[0]?.defaults, rich.defaults);
  assert.equal(index.records.length, 1);
});

await test('the same symbol in different Bevy versions keeps separate identities', () => {
  const index = new BevyIndex();
  index.addRecords([record('Current docs.'), { ...record('Historical docs.'), bevy_version: '0.15.3' }]);
  assert.equal(index.records.length, 2);
  assert.equal(index.byId.size, 2);
});

await test('an explicit reused ID cannot replace an unrelated API record', () => {
  const index = new BevyIndex();
  index.addRecords([{ ...record('Widget.'), id: 'conflicting-id' }]);
  assert.throws(() => index.addRecords([{ ...record('Other.'), id: 'conflicting-id', name: 'Other', full_path: 'bevy::Other' }]), /ID collision/);
  assert.equal(index.records[0]?.name, 'Widget');
});
