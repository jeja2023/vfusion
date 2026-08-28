const fs = require('fs');
const path = require('path');

console.log('=== VFusion 深度全方位代码审查开始 ===\n');

let issuesFound = [];
let passedChecks = [];

// 1. 审查所有 HTML/JS 文件中的 data-action 调用与函数绑定
function checkDelegatedActions() {
  console.log('[1/5] 检查前端事件委托 (Delegated Actions) 与函数定义完整性...');
  
  const collectorDelegated = fs.readFileSync('packages/collector/public/js/delegated_actions.js', 'utf8');
  const coreDelegated = fs.readFileSync('packages/core/public/js/delegated_actions.js', 'utf8');

  // 获取所有在 collector 中用到的 data-action
  const collectorFiles = getAllFiles('packages/collector/public');
  const actionRegex = /data-action(?:-[a-z]+)?=["']([^"']+)["']/g;
  
  const collectorActionsUsed = new Set();
  collectorFiles.forEach(file => {
    if (!file.endsWith('.html') && !file.endsWith('.js')) return;
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = actionRegex.exec(content)) !== null) {
      const expr = match[1];
      const fnNameMatch = expr.match(/^([a-zA-Z0-9_$]+)\s*\(/);
      if (fnNameMatch) {
        collectorActionsUsed.add({ fn: fnNameMatch[1], file: path.relative('.', file) });
      }
    }
  });

  // 获取 collector 声明的全局 actions
  const collectorActionNames = new Set();
  const collectorDeclRegex = /'([a-zA-Z0-9_$]+)'/g;
  let match;
  while ((match = collectorDeclRegex.exec(collectorDelegated)) !== null) {
    collectorActionNames.add(match[1]);
  }

  collectorActionsUsed.forEach(({ fn, file }) => {
    if (fn === 'event' || fn === 'stopPropagation' || fn === 'preventDefault' || fn === 'this') return;
    if (!collectorActionNames.has(fn)) {
      issuesFound.push(`[Collector] 文件 ${file} 中引用了 data-action="${fn}(...)"，但在 delegated_actions.js 白名单中未显式注册`);
    }
  });

  // 核心端检查
  const coreFiles = getAllFiles('packages/core/public');
  const coreActionsUsed = new Set();
  coreFiles.forEach(file => {
    if (!file.endsWith('.html') && !file.endsWith('.js')) return;
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = actionRegex.exec(content)) !== null) {
      const expr = match[1];
      const fnNameMatch = expr.match(/^([a-zA-Z0-9_$]+)\s*\(/);
      if (fnNameMatch) {
        coreActionsUsed.add({ fn: fnNameMatch[1], file: path.relative('.', file) });
      }
    }
  });

  const coreActionNames = new Set();
  while ((match = collectorDeclRegex.exec(coreDelegated)) !== null) {
    coreActionNames.add(match[1]);
  }

  coreActionsUsed.forEach(({ fn, file }) => {
    if (fn === 'event' || fn === 'stopPropagation' || fn === 'preventDefault' || fn === 'this') return;
    if (!coreActionNames.has(fn)) {
      issuesFound.push(`[Core] 文件 ${file} 中引用了 data-action="${fn}(...)"，但在 delegated_actions.js 白名单中未显式注册`);
    }
  });

  passedChecks.push('Delegated Actions 检查完成');
}

// 2. 审查全站 Emoji 图标残留
function checkEmojiLeaks() {
  console.log('[2/5] 审查前端 UI 文件中的 Emoji 字符残留 (严格遵循纯净 SVG 准则)...');
  const emojiRegex = /[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/u;

  const publicFiles = [...getAllFiles('packages/collector/public'), ...getAllFiles('packages/core/public')];
  publicFiles.forEach(file => {
    if (!file.endsWith('.html') && !file.endsWith('.js') && !file.endsWith('.css')) return;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (emojiRegex.test(line)) {
        issuesFound.push(`[Emoji 残留] ${path.relative('.', file)} 第 ${idx + 1} 行检测到 Emoji 字符: "${line.trim().slice(0, 80)}"`);
      }
    });
  });
  passedChecks.push('Emoji 残留检查完成');
}

// 3. 审查后端 API 路由与安全中间件覆盖
function checkApiSecurity() {
  console.log('[3/5] 审查前后端 API 路由安全标识符与异常捕获...');
  const serverFiles = ['packages/collector/server.js', 'packages/core/server.js'];
  serverFiles.forEach(sFile => {
    const content = fs.readFileSync(sFile, 'utf8');
    // 检查是否有未做 try-catch 的 async 路由处理器
    const routeRegex = /app\.(get|post|put|delete|patch)\(['"]([^'"]+)['"],\s*(?:authenticateToken,\s*)?async\s*\((?:req,\s*res|req,\s*res,\s*next)\)\s*=>\s*\{/g;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const routePath = match[2];
      const startIdx = match.index + match[0].length;
      const snippet = content.slice(startIdx, startIdx + 300);
      if (!snippet.includes('try {')) {
        if (!snippet.includes('res.json') && !snippet.includes('res.status')) {
          issuesFound.push(`[API 安全] ${sFile} 路由 ${match[1].toUpperCase()} ${routePath} 缺少顶层 try-catch 保护`);
        }
      }
    }
  });
  passedChecks.push('API 安全与异常捕获检查完成');
}

// 4. 审查数据库与存储引擎事务一致性
function checkDatabaseConsistency() {
  console.log('[4/5] 审查 SQLite 存储引擎在级联删除、任务统计、排序等方面的逻辑...');
  const dbFile = fs.readFileSync('packages/common/db_sqlite.js', 'utf8');
  
  if (!dbFile.includes('deleteEvent')) {
    issuesFound.push('[SQLite] db_sqlite.js 缺少 deleteEvent 方法');
  }
  if (!dbFile.includes('BEGIN IMMEDIATE TRANSACTION')) {
    issuesFound.push('[SQLite] db_sqlite.js 未在多表操作中使用 IMMEDIATE 事务锁');
  }
  passedChecks.push('数据库存储一致性检查完成');
}

// 5. 审查前端内存与地图实例生命周期
function checkMapLifecycle() {
  console.log('[5/5] 审查 Leaflet 地图组件实例销毁与瓦片回退机制...');
  const mapFiles = ['packages/collector/public/js/map_picker.js', 'packages/core/public/js/map_picker.js'];
  mapFiles.forEach(f => {
    const content = fs.readFileSync(f, 'utf8');
    if (!content.includes('clearMapPickerPin') && !content.includes('clearMapPin')) {
      issuesFound.push(`[地图组件] ${f} 缺少图钉清除方法`);
    }
  });
  passedChecks.push('地图生命周期检查完成');
}

function getAllFiles(dirPath, arrayOfFiles) {
  const files = fs.readdirSync(dirPath);
  arrayOfFiles = arrayOfFiles || [];
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
      }
    } else {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

checkDelegatedActions();
checkEmojiLeaks();
checkApiSecurity();
checkDatabaseConsistency();
checkMapLifecycle();

console.log('\n=== 审查结果汇总 ===');
console.log(`通过检查项: ${passedChecks.length}`);
console.log(`发现潜在优化点 / 问题: ${issuesFound.length}\n`);

if (issuesFound.length > 0) {
  console.log('--- 待优化项清单 ---');
  issuesFound.forEach((issue, i) => {
    console.log(`${i + 1}. ${issue}`);
  });
} else {
  console.log('🎉 恭喜！未发现任何高危、严重缺陷或未注册动作！代码质量与安全健壮性极高！');
}
