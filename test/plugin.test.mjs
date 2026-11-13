// Loads the real plugin entry point the way Cordis does and checks the whole
// registration path: inject -> effect -> tools.register -> dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/state.mjs';

const { apply, resolveOptions } = await import('../index.js');

function fakeContext() {
  const registered = new Map();
  const effects = [];
  const ctx = {
    inject(names, fn) {
      assert.deepEqual(names, ['tools']);
      return fn({
        tools: {
          register(definition) {
            assert.equal(registered.has(definition.name), false, `duplicate tool ${definition.name}`);
            registered.set(definition.name, definition);
            const dispose = () => registered.delete(definition.name);
            return dispose;
          },
        },
        effect(fn) {
          const dispose = fn();
          effects.push(dispose);
          return dispose;
        },
      });
    },
  };
  return { ctx, registered, effects };
}

test('apply registers every tool and the effect tears them down', () => {
  const { ctx, registered, effects } = fakeContext();
  const returned = apply(ctx, {});
  assert.equal(returned, undefined, 'a Cordis plugin must not need a return value');
  assert.equal(effects.length, 1, 'registration must live in one effect');
  assert.equal(typeof effects[0], 'function', 'the effect must return a disposer');
  assert.equal(registered.size, 14);

  assert.deepEqual([...registered.keys()].sort(), [
    'blender_execute',
    'blender_screenshot',
    'blender_status',
    'latex_build',
    'latex_status',
    'locus_instances',
    'unity_asset_read',
    'unity_asset_search',
    'unity_console',
    'unity_execute',
    'unity_menu',
    'unity_playmode',
    'unity_recompile',
    'unity_status',
  ]);

  for (const definition of registered.values()) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 40, `${definition.name} needs a usable description`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }

  effects[0]();
  assert.equal(registered.size, 0, 'disposing the effect must unregister everything');
});

test('allowExecute false blocks both execution tools', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { allowExecute: false });
  for (const name of ['unity_execute', 'blender_execute']) {
    await assert.rejects(
      () => registered.get(name).execute({ code: '1' }, {}),
      /allowExecute/,
      `${name} should refuse to run code`,
    );
  }
});

test('resolveOptions normalises hostile config', () => {
  const options = resolveOptions({
    allowExecute: 0,
    timeoutMs: -5,
    processTimeoutMs: 'nope',
    latexEngine: 'LaTeX3',
    svgPreview: 'no',
  });
  assert.equal(options.allowExecute, false);
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.processTimeoutMs, 120000);
  assert.equal(options.latexEngine, 'auto');
  assert.equal(options.svgPreview, true);
});
