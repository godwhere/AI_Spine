import { browserPixels } from "./browser-pixels.js";
import { addTemplateVariant as addTemplateVariantEngine } from "../../engine/archive/template-variants.js";

export function addTemplateVariant(...args) { args[2] = { ...browserPixels, ...args[2] }; return addTemplateVariantEngine(...args); }
