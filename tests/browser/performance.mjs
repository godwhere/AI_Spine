export async function startInteractionMeasurement(page) {
  await page.evaluate(() => {
    const phases = [{ name: "calibration", at: performance.now() }], entries = [];
    const collect = (items) => { for (const item of items) entries.push({ startTime: item.startTime, duration: item.duration,
      phase: phases.findLast((phase) => phase.at <= item.startTime)?.name || "initialization" }); };
    const observer = new PerformanceObserver((list) => collect(list.getEntries())); observer.observe({ type: "longtask", buffered: false });
    window.__ispineInteractionMeasurement = { phases, entries, observer, collect };
  });
}
export async function markInteraction(page, name) {
  await page.evaluate((name) => { window.__ispineInteractionMeasurement.phases.push({ name, at: performance.now() }); }, name);
}
export async function finishInteractionMeasurement(page) {
  return page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const { phases, entries, observer, collect } = window.__ispineInteractionMeasurement;
    collect(observer.takeRecords()); observer.disconnect(); delete window.__ispineInteractionMeasurement;
    return { phases, entries, longTasks: entries.length, totalLongTaskMs: entries.reduce((total, item) => total + item.duration, 0),
      maximumLongTaskMs: Math.max(0, ...entries.map((item) => item.duration)), thresholdMs: 50, measuredInRealBrowser: true };
  });
}
