import { validateRigDocument } from "../../shared/rig-schema.mjs";

function createHumanoidDraft({ id, name = "人形骨架初稿", width = 768, height = 1024, sourceImage } = {}) {
  const joint = (id, label, parent, x, y) => ({ id, label, parent, x: x * width, y: y * height });
  const joints = [joint("root", "骨盆", null, .5, .61), joint("torso", "胸腔", "root", .5, .49),
    joint("neck", "颈部", "torso", .5, .32), joint("head", "头部", "neck", .5, .20),
    joint("leftUpperArm", "左肩", "torso", .34, .38), joint("leftForearm", "左肘", "leftUpperArm", .25, .53), joint("leftHand", "左手", "leftForearm", .27, .66),
    joint("rightUpperArm", "右肩", "torso", .66, .38), joint("rightForearm", "右肘", "rightUpperArm", .75, .53), joint("rightHand", "右手", "rightForearm", .73, .66),
    joint("leftThigh", "左髋", "root", .43, .61), joint("leftShin", "左膝", "leftThigh", .35, .77), joint("leftFoot", "左脚踝", "leftShin", .40, .92), joint("leftToe", "左脚尖", "leftFoot", .33, .94),
    joint("rightThigh", "右髋", "root", .57, .61), joint("rightShin", "右膝", "rightThigh", .65, .77), joint("rightFoot", "右脚踝", "rightShin", .60, .92), joint("rightToe", "右脚尖", "rightFoot", .67, .94)];
  const part = (id, label, bone, x, y, w, h, z, influences = [bone], binding = "mesh") => ({
    id, label, bone, x: x * width, y: y * height, width: w * width, height: h * height, z,
    binding, influences, completion: "needs-inpaint", imageSource: sourceImage ? "source-crop" : "placeholder", critical: true,
  });
  const parts = [part("leftUpperArm", "左上臂", "leftUpperArm", .17, .33, .23, .25, 0, ["leftUpperArm", "leftForearm"]),
    part("leftForearm", "左前臂", "leftForearm", .15, .49, .22, .19, 1, ["leftForearm", "leftHand"]),
    part("leftHand", "左手", "leftHand", .17, .59, .20, .14, 2, ["leftHand"], "rigid"),
    part("leftThigh", "左大腿", "leftThigh", .28, .57, .23, .25, 3, ["leftThigh", "leftShin"]),
    part("leftShin", "左小腿", "leftShin", .28, .74, .22, .20, 4, ["leftShin", "leftFoot"]),
    part("leftFoot", "左脚", "leftFoot", .25, .87, .26, .12, 5, ["leftFoot"], "rigid"),
    part("rightThigh", "右大腿", "rightThigh", .49, .57, .23, .25, 6, ["rightThigh", "rightShin"]),
    part("rightShin", "右小腿", "rightShin", .50, .74, .22, .20, 7, ["rightShin", "rightFoot"]),
    part("rightFoot", "右脚", "rightFoot", .49, .87, .26, .12, 8, ["rightFoot"], "rigid"),
    part("torso", "躯干", "torso", .29, .32, .42, .34, 9, ["root", "torso", "neck"]),
    part("rightUpperArm", "右上臂", "rightUpperArm", .60, .33, .23, .25, 10, ["rightUpperArm", "rightForearm"]),
    part("rightForearm", "右前臂", "rightForearm", .63, .49, .22, .19, 11, ["rightForearm", "rightHand"]),
    part("rightHand", "右手", "rightHand", .63, .59, .20, .14, 12, ["rightHand"], "rigid"),
    part("head", "头部", "head", .20, .02, .60, .34, 13, ["head"], "rigid")];
  const pose = (time, angles = {}, root = { x: 0, y: 0 }) => ({ time, angles, root, ease: "smooth", feet: { left: true, right: true } });
  const motions = [
    { id: "idle", name: "待机", duration: 2, loop: true, origin: "procedural-draft", description: "程序初稿：轻微呼吸，两脚锁定。",
      poses: [pose(0), pose(.5, { torso: -1, leftUpperArm: 1, rightUpperArm: -1 }, { x: 0, y: -.003 * height }), pose(1), pose(1.5, { torso: 1, leftUpperArm: -1, rightUpperArm: 1 }, { x: 0, y: .003 * height }), pose(2)] },
    { id: "attack", name: "攻击", duration: 1.1, loop: false, origin: "procedural-draft", description: "程序初稿：蓄力、挥击、收势，需要按角色武器检查。",
      poses: [pose(0), pose(.28, { torso: -8, rightUpperArm: -65, rightForearm: -35, leftUpperArm: 20 }, { x: -.01 * width, y: .006 * height }),
        pose(.52, { torso: 12, rightUpperArm: 20, rightForearm: -55, leftUpperArm: -10 }, { x: .018 * width, y: .012 * height }), pose(.77, { torso: 4, rightUpperArm: 8, rightForearm: -15 }), pose(1.1)] },
    { id: "hit", name: "受击", duration: .6, loop: false, origin: "procedural-draft", description: "程序初稿：上身后仰后恢复，两脚锁定。",
      poses: [pose(0), pose(.16, { torso: -10, head: 6, leftUpperArm: -10, rightUpperArm: 12 }, { x: -.012 * width, y: .006 * height }), pose(.34, { torso: -3, head: 2 }), pose(.6)] },
  ];
  return validateRigDocument({ version: 1, id, name, width, height, ...(sourceImage ? { sourceImage } : {}), origin: "procedural-draft", joints, parts, motions });
}

export { createHumanoidDraft };
