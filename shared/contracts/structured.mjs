export function validateStructured(value, schema) {
  const invalid = () => { throw new Error("AI 返回的结构化字段不符合本次分析格式，请重新分析。"); };
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(type) && !(type === "number" && types.includes("integer") && Number.isInteger(value))) invalid();
  if (schema.enum && !schema.enum.includes(value)) invalid();
  if (type === "number" && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) invalid();
  if (type === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) invalid();
  if (type === "array") {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) invalid();
    for (const item of value) validateStructured(item, schema.items);
  }
  if (type === "object") {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) invalid();
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) { if (schema.additionalProperties === false) invalid(); }
      else validateStructured(item, schema.properties[key]);
    }
  }
  return value;
}

