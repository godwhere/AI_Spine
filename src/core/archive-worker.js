function request(message) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./package.worker.js", import.meta.url), {
      type: "module",
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("资源包处理超时，请缩小文件后重试。"));
    }, 120000);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("资源包处理失败，请检查文件并重试。"));
    };
    worker.postMessage(message);
  });
}
export const unpackInWorker = (bytes) =>
  request({ operation: "unpack", bytes });
export const exportInWorker = (bundle, pages, options) =>
  request({ operation: "export", bundle, pages, options });
