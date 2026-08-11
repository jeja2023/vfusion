async function loadAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    const json = await res.json();
    if (json.success) {
      const stats = json.data.threatStats;
      const total = json.data.totalCount || 1;
      const highPct = Math.round((stats.高 / total) * 100);
      const medPct = Math.round((stats.中 / total) * 100);
      const lowPct = Math.round((stats.低 / total) * 100);

      const donutHigh = document.getElementById('donutHigh');
      const donutMed = document.getElementById('donutMed');
      const donutLow = document.getElementById('donutLow');

      if (donutHigh) donutHigh.setAttribute('stroke-dasharray', `${highPct} ${100 - highPct}`);
      if (donutMed) donutMed.setAttribute('stroke-dasharray', `${medPct} ${100 - medPct}`);
      if (donutLow) donutLow.setAttribute('stroke-dasharray', `${lowPct} ${100 - lowPct}`);
    }
  } catch (e) {
    console.error('加载分析图表数据失败:', e);
  }
}
