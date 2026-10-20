import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { rigDefaultVisiblePartIds } from "../src/core/rig-client.js";

const source = await readFile(new URL("../src/components/RigCanvas.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source.replace(/^import .*;\n/gm, "").replace("export function RigCanvas", "function RigCanvas"), "RigCanvas.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const factory = new Function("useRef", "useState", "useEffect", "rigDefaultVisiblePartIds", "jsx", "React", `${code};return RigCanvas;`);
const descendants = node => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(descendants)] : [];
const event = (values = {}) => ({ pointerId: 7, button: 0, preventDefault() {}, stopPropagation() {}, ...values });

function documentFixture() {
  return { id: "manual-adjustment", width: 512, height: 512,
    joints: [{ id: "root", label: "根关节", x: 90, y: 100, parent: null }, { id: "hand", x: 130, y: 140, parent: "root" }],
    parts: [
      { id: "back", label: "后发", bone: "root", x: 100, y: 120, width: 80, height: 60, z: 1, image: "back.png" },
      { id: "front", label: "前发", bone: "hand", x: 110, y: 130, width: 40, height: 40, z: 2, image: "front.png" },
    ] };
}

function canvas(initialProps = {}) {
  const cells = [], captures = [], releases = [], calls = [], jointMoves = [], selections = [];
  let cursor = 0, tree, props, activeSnapshot = null, inverseAvailable = true, rendering = false, dirty = false, effects = [], mounted = true;
  let document = structuredClone(initialProps.document || documentFixture());
  let undo = ["earlier undo"], redo = ["earlier redo"];
  const dom = {
    focus() {},
    setPointerCapture(id) { captures.push(id); },
    releasePointerCapture(id) { releases.push(id); },
    hasPointerCapture(id) { return captures.includes(id) && !releases.includes(id); },
    getScreenCTM() { return inverseAvailable ? { inverse: () => ({ a: .5, b: 0, c: 0, d: 1 / 3, e: -50, f: -50 / 3 }) } : null; },
    createSVGPoint() { return { x: 0, y: 0, matrixTransform(matrix) {
      return { x: matrix.a * this.x + matrix.c * this.y + matrix.e, y: matrix.b * this.x + matrix.d * this.y + matrix.f };
    } }; },
  };
  const Component = factory(value => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = { current: value };
    return cells[index];
  }, initial => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = { value: typeof initial === "function" ? initial() : initial };
    return [cells[index].value, value => {
      const next = typeof value === "function" ? value(cells[index].value) : value;
      if (!Object.is(next, cells[index].value)) { cells[index].value = next; dirty = true; render(); }
    }];
  }, (callback, dependencies) => {
    const index = cursor++, previous = cells[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      cells[index] = { dependencies };
      effects.push(() => { previous?.cleanup?.(); cells[index].cleanup = callback(); });
    }
  }, rigDefaultVisiblePartIds, jsx, { Fragment: "fragment" });
  const render = () => {
    if (!mounted) return tree;
    if (rendering) { dirty = true; return tree; }
    rendering = true;
    do {
      dirty = false; cursor = 0; tree = Component({ ...props, document });
      descendants(tree).find(node => node.type === "svg").props.ref.current = dom;
      const scheduled = effects; effects = []; scheduled.forEach(callback => callback());
    } while (dirty);
    rendering = false;
    return tree;
  };
  props = { selectedPart: "back", selectedJoint: "root", editingTool: "parts", showImage: false,
    onSelectPart(id) { selections.push(id); props.selectedPart = id; render(); },
    onSelectJoint() {}, onBeginMove() {}, onMoveJoint: (...values) => jointMoves.push(values),
    onBeginPartMove() {
      calls.push(["begin"]); activeSnapshot = { document: structuredClone(document), undo: [...undo], redo: [...redo] };
      undo.push(structuredClone(document)); redo = [];
    },
    onMovePart(id, x, y) {
      calls.push(["move", id, x, y]); document = structuredClone(document);
      Object.assign(document.parts.find(part => part.id === id), { x, y }); render();
    },
    onEndPartMove() { calls.push(["end"]); activeSnapshot = null; },
    onCancelPartMove({ preserveDocument = false } = {}) {
      calls.push(["cancel"]);
      if (!preserveDocument) document = activeSnapshot.document;
      ({ undo, redo } = activeSnapshot); activeSnapshot = null; render();
    }, ...initialProps };
  render();
  const nodes = () => descendants(tree);
  return {
    render, nodes, calls, captures, releases, jointMoves, selections,
    svg: () => nodes().find(node => node.type === "svg"),
    handle: () => nodes().find(node => node.props["aria-label"] === `移动部件 ${document.parts.find(part => part.id === props.selectedPart)?.label}`),
    part: (id = props.selectedPart) => document.parts.find(part => part.id === id),
    visualPart(id = props.selectedPart) {
      const part = document.parts.find(part => part.id === id), node = nodes().find(node => node.props["data-rig-part"] === id);
      const [x, y] = node?.props.transform?.match(/-?[\d.]+/g)?.map(Number) || [0, 0];
      return { ...part, x: part.x + x, y: part.y + y };
    },
    document: () => document, undo: () => undo, redo: () => redo,
    update(next) { if (next.document) document = structuredClone(next.document); Object.assign(props, next); render(); },
    unmount() { mounted = false; cells.forEach(cell => { cell.cleanup?.(); cell.cleanup = null; }); },
    noMatrix() { inverseAvailable = false; },
    screen(x, y, values) { return event({ clientX: x * 2 + 100, clientY: y * 3 + 50, ...values }); },
  };
}

test("selected part handles drag through the SVG inverse transform without a jump and record one undo", () => {
  const ui = canvas(), before = structuredClone(ui.document());
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  assert.deepEqual(ui.captures, [7]); assert.deepEqual(ui.calls, []);
  ui.svg().props.onPointerMove(ui.screen(140, 150));
  assert.deepEqual(ui.calls, []); // A click or zero movement must not create an undo entry.
  ui.svg().props.onPointerMove(ui.screen(160, 160));
  assert.equal(ui.visualPart().x, 120); assert.equal(ui.visualPart().y, 130);
  assert.deepEqual(ui.document(), before); // Large native images are not revalidated on every pointer move.
  ui.svg().props.onPointerMove(ui.screen(165, 170));
  assert.equal(ui.visualPart().x, 125); assert.equal(ui.visualPart().y, 140);
  assert.deepEqual(ui.calls.map(call => call[0]), ["begin"]);
  ui.svg().props.onPointerUp(event());
  assert.equal(ui.part().x, 125); assert.equal(ui.part().y, 140);
  assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "move", "end"]);
  assert.equal(ui.undo().length, 2); assert.deepEqual(ui.undo()[1], before);
  assert.deepEqual(ui.releases, [7]); assert.deepEqual(ui.jointMoves, []);
  assert.deepEqual(ui.document().joints, before.joints);
  assert.deepEqual(ui.part("front"), before.parts[1]);
  const count = ui.calls.length;
  ui.svg().props.onPointerMove(ui.screen(190, 190));
  ui.svg().props.onLostPointerCapture(event());
  assert.equal(ui.calls.length, count);
});

test("parts are fully opaque, joints and mesh handles are hidden, and the selected box sits above overlapping art", () => {
  const ui = canvas({ mesh: { triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 10, 10], weights: [[], [], []] } });
  const nodes = ui.nodes(), parts = nodes.filter(node => node.props["data-rig-part"]);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.equal(part.children.find(node => node.type === "image").props.opacity, 1);
    const rect = part.children.find(node => node.type === "rect");
    assert.equal(rect.props.fill, "none"); assert.equal(rect.props.pointerEvents, "stroke");
  }
  assert.equal(nodes.filter(node => node.props["aria-label"]?.startsWith("关节 ")).length, 0);
  assert.equal(nodes.filter(node => node.props.className === "rig-mesh-overlay").length, 0);
  const selection = nodes.find(node => node.props["data-rig-part-adjustment"]);
  assert.ok(nodes.indexOf(selection) > nodes.indexOf(parts[1]));
  assert.equal(selection.children.find(node => node.type === "rect").props.pointerEvents, "stroke");
  assert.equal(ui.handle().props.role, "button"); assert.equal(ui.handle().props.tabIndex, 0);
  assert.equal(ui.svg().props["aria-label"], "手动调整部件位置");
  parts[1].props.onPointerDown(event());
  assert.deepEqual(ui.selections, ["front"]); assert.deepEqual(ui.calls, []);
  assert.equal(ui.handle().props["aria-label"], "移动部件 前发");
});

test("a pointer click without movement never adds undo or sends end/cancel callbacks", () => {
  const ui = canvas();
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  ui.svg().props.onPointerUp(event());
  assert.deepEqual(ui.calls, []); assert.equal(ui.undo().length, 1);
  assert.deepEqual(ui.redo(), ["earlier redo"]);
});

test("keyboard movement is one pixel or Shift ten pixels with a complete begin/move/end transaction", () => {
  const ui = canvas(), before = structuredClone(ui.document().joints);
  ui.handle().props.onKeyDown(event({ key: "ArrowRight" }));
  assert.equal(ui.part().x, 101); assert.equal(ui.part().y, 120);
  ui.svg().props.onKeyDown(event({ key: "ArrowUp", shiftKey: true }));
  assert.equal(ui.part().x, 101); assert.equal(ui.part().y, 110);
  assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "move", "end", "begin", "move", "end"]);
  assert.equal(ui.undo().length, 3); assert.deepEqual(ui.document().joints, before);
  const count = ui.calls.length;
  ui.handle().props.onKeyDown(event({ key: "ArrowRight", metaKey: true }));
  assert.equal(ui.calls.length, count);
});

test("disabled, pose, registration, and hidden-part states cannot move setup parts", () => {
  for (const props of [{ disabled: true }, { pose: { joints: {}, visiblePartIds: ["back", "front"] } },
    { registration: { polygons: {}, mode: "source" } }, { showParts: false }, { visiblePartIds: [] }]) {
    const ui = canvas(props), before = structuredClone(ui.document());
    assert.equal(ui.handle(), undefined);
    ui.svg().props.onKeyDown(event({ key: "ArrowRight" }));
    ui.svg().props.onPointerMove(ui.screen(200, 200));
    ui.svg().props.onPointerUp(event());
    assert.deepEqual(ui.calls, []); assert.deepEqual(ui.document(), before);
  }
});

for (const cancel of ["pointercancel", "capturelost", "Escape"]) {
  test(`${cancel} restores the entire move and undo/redo state, then clears pointer capture`, () => {
    const ui = canvas(), before = structuredClone(ui.document());
    ui.handle().props.onPointerDown(ui.screen(140, 150));
    ui.svg().props.onPointerMove(ui.screen(165, 175));
    assert.equal(ui.undo().length, 2); assert.notEqual(ui.visualPart().x, before.parts[0].x);
    if (cancel === "Escape") ui.svg().props.onKeyDown(event({ key: "Escape" }));
    else ui.svg().props[cancel === "pointercancel" ? "onPointerCancel" : "onLostPointerCapture"](event());
    assert.deepEqual(ui.document(), before); assert.deepEqual(ui.undo(), ["earlier undo"]);
    assert.deepEqual(ui.redo(), ["earlier redo"]);
    assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "cancel"]);
    assert.deepEqual(ui.releases, [7]);
    ui.svg().props.onPointerMove(ui.screen(180, 190)); ui.svg().props.onPointerUp(event());
    assert.equal(ui.calls.length, 2);
  });
}

test("mode changes during a captured drag cancel rather than leave an unfinished move", () => {
  const ui = canvas(), before = structuredClone(ui.document());
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  ui.svg().props.onPointerMove(ui.screen(160, 170));
  ui.update({ disabled: true }); ui.svg().props.onPointerMove(ui.screen(190, 200));
  assert.deepEqual(ui.document(), before);
  assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "cancel"]);
});

test("an external document edit cancels the local preview without overwriting the new edit", () => {
  const ui = canvas();
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  ui.svg().props.onPointerMove(ui.screen(170, 180));
  const external = structuredClone(ui.document()); external.parts[1].x = 150;
  ui.update({ document: external });
  assert.deepEqual(ui.document(), external);
  assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "cancel"]);
  ui.svg().props.onPointerUp(event());
  assert.equal(ui.calls.length, 2);
});

test("unmount releases an active capture and cancels its undo placeholder without committing stale coordinates", () => {
  const ui = canvas(), before = structuredClone(ui.document());
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  ui.svg().props.onPointerMove(ui.screen(170, 180));
  ui.unmount();
  assert.deepEqual(ui.document(), before); assert.deepEqual(ui.undo(), ["earlier undo"]);
  assert.deepEqual(ui.releases, [7]); assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "cancel"]);
});

test("moving back to the starting position cancels the empty undo entry", () => {
  const ui = canvas(), before = structuredClone(ui.document());
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  ui.svg().props.onPointerMove(ui.screen(160, 170));
  ui.svg().props.onPointerMove(ui.screen(140, 150));
  ui.svg().props.onPointerUp(event());
  assert.deepEqual(ui.document(), before); assert.deepEqual(ui.undo(), ["earlier undo"]);
  assert.deepEqual(ui.calls.map(call => call[0]), ["begin", "cancel"]);
});

test("missing or singular screen transforms never send a bogus origin position", () => {
  for (const unavailable of ["null", "singular"]) {
    const ui = canvas(), before = structuredClone(ui.document());
    if (unavailable === "null") ui.noMatrix();
    else ui.svg().props.ref.current.getScreenCTM = () => ({ inverse() { throw new Error("singular"); } });
    ui.handle().props.onPointerDown(ui.screen(140, 150));
    ui.svg().props.onPointerMove(ui.screen(160, 170)); ui.svg().props.onPointerUp(event());
    assert.deepEqual(ui.calls, []); assert.deepEqual(ui.document(), before); assert.deepEqual(ui.captures, []);
  }
  const ui = canvas();
  ui.handle().props.onPointerDown(ui.screen(140, 150)); ui.noMatrix();
  ui.svg().props.onPointerMove(ui.screen(160, 170)); ui.svg().props.onPointerUp(event());
  assert.deepEqual(ui.calls, []);
});

test("other pointers cannot hijack a move, and part bounds remain inside the source canvas", () => {
  const ui = canvas();
  ui.handle().props.onPointerDown(ui.screen(140, 150));
  ui.svg().props.onPointerMove(ui.screen(200, 200, { pointerId: 8 }));
  ui.svg().props.onPointerUp(event({ pointerId: 8 }));
  assert.deepEqual(ui.calls, []);
  ui.svg().props.onPointerMove(ui.screen(999, 999));
  assert.equal(ui.visualPart().x, 432); assert.equal(ui.visualPart().y, 452);
  ui.svg().props.onPointerUp(event());
  assert.equal(ui.part().x, 432); assert.equal(ui.part().y, 452);
  const count = ui.calls.length;
  ui.handle().props.onKeyDown(event({ key: "ArrowRight" }));
  ui.handle().props.onKeyDown(event({ key: "ArrowDown", shiftKey: true }));
  assert.equal(ui.calls.length, count);
});

test("the default joint tool keeps its existing drag behavior and does not expose part movement", () => {
  const ui = canvas({ editingTool: "joints" });
  assert.equal(ui.handle(), undefined);
  const joint = ui.nodes().find(node => node.props["aria-label"] === "关节 根关节");
  joint.props.onPointerDown(ui.screen(93, 104));
  ui.svg().props.onPointerMove(ui.screen(103, 109));
  assert.deepEqual(ui.jointMoves, [["root", 100, 105]]);
  ui.svg().props.onPointerUp(event());
  assert.deepEqual(ui.calls, []);
});
