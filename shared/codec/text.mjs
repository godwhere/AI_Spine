const decodeText = (bytes) => new TextDecoder().decode(bytes);

const encodeText = (text) => new TextEncoder().encode(text);

export { decodeText, encodeText };
