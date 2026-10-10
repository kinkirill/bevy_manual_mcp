import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BevyIndex, findByPath, hybridSearch } from '../src/store.js';
import { fixtureRecord } from './helpers.mjs';

async function corpus(version = '0.20.0') {
  const index = new BevyIndex();
  const item = (name: string, module: string, kind = 'struct', owner?: string) => fixtureRecord({
    source: 'rustdoc', name, kind, owner, module, bevy_version: version,
    full_path: `${module}::${owner ? owner + '::' : ''}${name}`,
    signature: `pub ${kind} ${name};`, docs: `${name} documentation.`,
    source_ref: `https://docs.rs/bevy_ecs/${version}/src/bevy_ecs/${owner ?? name}.rs.html`,
  });
  const sphere = item('Sphere', 'bevy::math::primitives');
  sphere.source_ref = `https://docs.rs/bevy_math/${version}/src/bevy_math/primitives/dim3.rs.html`;
  sphere.docs = 'A sphere shape with a radius, used to build a mesh.';
  index.addRecords([
    item('Sphere', 'bevy::camera::primitives'), sphere,
    { ...sphere, full_path: 'bevy::prelude::Sphere', module: 'bevy::prelude' },
    item('spawn_scene', 'bevy::ecs::system', 'method', 'Commands'),
    item('Difference', 'bevy::platform::collections'), item('System', 'bevy::ecs::system', 'trait'),
    item('Event', 'bevy::ecs::event', 'trait'),
    item('Event', 'bevy::log::tracing'), item('Message', 'bevy::serialization', 'variant', 'Error'),
    item('Thread', 'bevy::tasks'), item('Client', 'bevy::networking'), item('Server', 'bevy::networking'),
    { ...item('StandardMaterial', 'bevy::pbr'), docs: 'A material created from a color or image.' },
    { ...item('MeshMaterial3d', 'bevy::pbr'), docs: 'Render a mesh using a material with a red base color.' },
    { ...item('PreparedMaterial', 'bevy::pbr'), docs: 'Data prepared for a material instance.' },
    item('SphereMeshBuilder', 'bevy::mesh::primitives'),
  ]);
  for (let i = 0; i < 12; i++) {
    index.addRecords([
      item('bounding_sphere', 'bevy::math::primitives', 'method', `OtherShape${i}`),
      item(`MaterialHelper${i}`, 'bevy::pbr'),
    ]);
  }
  for (const module of ['bevy::ecs::message', 'bevy::ecs::prelude', 'bevy::prelude']) {
    for (const name of ['Message', 'MessageReader', 'MessageWriter', 'Messages']) {
      const record = item(name, module, name === 'Message' ? 'trait' : 'struct');
      record.source_ref = `https://docs.rs/bevy_ecs/${version}/src/bevy_ecs/${name}.rs.html`;
      index.addRecords([record]);
    }
  }
  index.meta = { bevy_version: version };
  index.buildSymbolTable();
  await index.buildTextIndex();
  return index;
}

await test('a comparison searches its subjects rather than the word difference', async () => {
  const index = await corpus();
  const hits = hybridSearch(index, 'Difference between message and event');
  assert.ok(hits.some(({ record }) => record.name === 'Message'));
  assert.ok(hits.some(({ record }) => record.name === 'Event'));
  assert.ok(hits.slice(0, 2).every(({ record }) => record.full_path.startsWith('bevy::ecs::')));
  assert.notEqual(hits[0]?.record.name, 'Difference');
  assert.equal(hybridSearch(index, 'Difference')[0]?.record.name, 'Difference');
});

await test('material context surfaces rendering APIs alongside the geometry', async () => {
  const index = await corpus();
  for (const query of ['How do I create a sphere with a red material?', 'Spawn a sphere with a material']) {
    const hits = hybridSearch(index, query);
    assert.ok(hits.some(({ record }) => record.full_path === 'bevy::math::primitives::Sphere'), query);
    assert.ok(hits.some(({ record }) => ['StandardMaterial', 'MeshMaterial3d'].includes(record.name)), query);
  }
  const materials = hybridSearch(index, 'How do I create a sphere with a red material?', { limit: 8, filters: { module: 'pbr' } });
  assert.equal(materials[0]?.record.name, 'MeshMaterial3d', 'red must match the documentation, rather than the substring in PreparedMaterial');
});

await test('mesh context retains the builder instead of unrelated noun-containing helpers', async () => {
  const index = await corpus();
  const hits = hybridSearch(index, 'How do I turn a sphere into a mesh?');
  assert.ok(hits.some(({ record }) => record.name === 'SphereMeshBuilder'));
  assert.ok(hits.slice(0, 3).every(({ record }) => record.kind !== 'method'));
});

await test('thread and client/server communication retain their subjects', async () => {
  const index = await corpus();
  assert.equal(hybridSearch(index, 'How do I communicate between threads?')[0]?.record.name, 'Thread');
  const network = hybridSearch(index, 'How do I communicate between a client and server?');
  assert.ok(network.slice(0, 2).every(({ record }) => ['Client', 'Server'].includes(record.name)));
  assert.ok(network.slice(0, 2).every(({ record }) => !record.full_path.startsWith('bevy::ecs::')));
  assert.ok(hybridSearch(index, 'How do I communicate in ECS?').some(({ record }) => record.name === 'Messages'));
});

await test('sphere creation prioritizes geometry over a camera bounding sphere or scene method', async () => {
  const index = await corpus();
  for (const query of ['How to spawn a sphere', 'How do I spawn a sphere in a 3D scene?']) {
    assert.equal(hybridSearch(index, query)[0]?.record.full_path, 'bevy::math::primitives::Sphere', query);
  }
});

await test('read and write questions surface the corresponding available message APIs', async () => {
  const index = await corpus();
  assert.ok(hybridSearch(index, 'How can a system read messages?').some(({ record }) => record.name === 'MessageReader'));
  assert.ok(hybridSearch(index, 'How do I send messages between systems?').some(({ record }) => record.name === 'MessageWriter'));
  assert.ok(hybridSearch(index, 'How do I communicate between systems?').some(({ record }) => record.name === 'Messages'));
});

await test('general search collapses reexports but exact paths still resolve', async () => {
  const index = await corpus();
  const hits = hybridSearch(index, 'How can a system read messages?');
  assert.equal(hits.filter(({ record }) => record.name === 'MessageReader').length, 1);
  assert.equal(index.lookupSymbol('bevy::prelude::MessageReader')[0]?.record.full_path, 'bevy::prelude::MessageReader');
});

await test('subject candidates respect source, module and kind filters', async () => {
  const index = await corpus();
  const hits = hybridSearch(index, 'How do I communicate between systems?', { filters: { module: 'ecs::message', kind: 'trait', source: 'rustdoc' } });
  assert.ok(hits.length > 0);
  assert.ok(hits.every(({ record }) => record.full_path.startsWith('bevy::ecs::message::') && record.kind === 'trait'));
});

await test('an API resource chooses the trait over a same-path derive macro', () => {
  const index = new BevyIndex();
  const base = fixtureRecord({ source: 'rustdoc', name: 'Event', full_path: 'bevy::ecs::event::Event', module: 'bevy::ecs::event', bevy_version: '0.20.0' });
  index.addRecords([{ ...base, kind: 'derive', signature: '#[derive(Event)]' }, { ...base, kind: 'trait', signature: 'pub trait Event {}' }]);
  index.buildSymbolTable();
  assert.equal(findByPath(index, '0.20.0', base.full_path)?.kind, 'trait');
});
