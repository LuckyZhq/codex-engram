#!/usr/bin/env node
/**
 * D1 渲染验收脚本：用真实浏览器（系统 Chrome）驱动 codex/ui，逐项断言
 * 「完整界面渲染 / 主题令牌解析 / 九视图数据 / 交互路径」，全部通过才 exit 0。
 *
 * 用法：
 *   先起 dev server（含 mock API）：pnpm dev:ui
 *   再跑：node codex/ui/scripts/verify-render.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3927/。
 *
 * 选择器说明：面板类名走 CSS Modules（dev/生产均为 _local_hash 形态），
 * 精确类名不可用，一律用 [class*="localName"] 子串匹配；主 Tab Bar 用
 * [class*="tabs"] 限定，避免与入殿导航的 focus chips（同占 role=tab）混淆。
 *
 * 依赖解析：优先仓库 node_modules 的 playwright-core；否则找全局
 * @playwright/cli 自带的 playwright-core（本机 CLI 为全局安装）。
 * 截图输出到 codex/ui/.verify/（一次性证据目录，可手删）。
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(join(repoRoot, 'package.json'))

/** 依次尝试解析 playwright-core。 */
function loadPlaywright() {
  const candidates = [
    'playwright-core',
    'C:/Users/ZHQ/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@playwright/cli/node_modules/playwright-core',
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      /* 试下一个 */
    }
  }
  console.error('[verify] 未找到 playwright-core：请先 npm install -g @playwright/cli@latest')
  process.exit(2)
}

const { chromium } = loadPlaywright()

const BASE = process.argv[2] ?? 'http://127.0.0.1:3927/'
const OUT_DIR = join(repoRoot, 'codex', 'ui', '.verify')
mkdirSync(OUT_DIR, { recursive: true })

/** 主 Tab Bar 内的 tab（避开入殿导航 focus chips）。 */
const MAIN_TAB = label => `[class*="tabs"] [role="tab"]:has-text("${label}")`

/** 断言收集器。 */
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

/** 面板期望的 13 个 DSH 主题令牌。 */
const DSW_TOKENS = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-fill-tsp-secondary',
  '--dsw-alias-brand-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary',
]

const TAB_LABELS = ['今日', '陈展', '走廊', '往事', '实体', '信念', '日志', '回填', '裁决']

async function main() {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  const consoleErrors = []
  const pageErrors = []
  const failedRequests = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => { pageErrors.push(error.message) })
  page.on('requestfailed', request => { failedRequests.push(request.url()) })
  page.on('response', response => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`)
  })

  console.log(`[verify] 打开 ${BASE}`)
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // ---------- 1. 完整界面渲染 ----------
  console.log('\n[1] 完整界面渲染')
  await page.waitForFunction(() => {
    const el = document.querySelector('[class*="metricValue"]')
    return el !== null && el.textContent !== '0'
  }, { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(800)

  const tabTexts = await page.$$eval('[class*="tabs"] [role="tab"]', nodes => nodes.map(n => n.textContent?.trim() ?? ''))
  check('九视图 Tab 齐全', TAB_LABELS.every(label => tabTexts.some(t => t.includes(label))),
    `实际：${tabTexts.join('/')}`)

  const metricTexts = await page.$$eval('[class*="metricValue"]', nodes => nodes.map(n => n.textContent?.trim() ?? ''))
  check('今日速览主指标非零', metricTexts.length >= 3 && metricTexts.slice(0, 3).every(t => t !== '0' && t !== ''),
    `实际：${metricTexts.join(' | ')}`)

  const healthScore = await page.$eval('[class*="ring"] b', n => n.textContent?.trim() ?? '').catch(() => '')
  check('健康分环有分数', healthScore !== '' && Number(healthScore) > 0, `实际：${healthScore}`)

  const roomRows = await page.$$eval('[class*="roomRow"]', nodes => nodes.length)
  check('房间目录 5 间', roomRows === 5, `实际：${roomRows}`)

  const profileText = await page.$eval('[class*="profileContent"]', n => n.textContent ?? '').catch(() => '')
  check('常驻画像有内容', profileText.includes('紧凑极简'), `实际前 40 字：${profileText.slice(0, 40)}`)

  const tourStops = await page.$$eval('[class*="tourStop"]', nodes => nodes.length)
  check('入殿导航有站点', tourStops > 0, `实际：${tourStops}`)

  const refurbCount = await page.$eval('[class*="refurbCount"]', n => n.textContent ?? '').catch(() => '')
  check('翻新清单有建议', refurbCount.includes('2'), `实际：${refurbCount}`)

  const cardCount = await page.$$eval('[class*="panelCard"]', nodes => nodes.length)
  check('面板卡片渲染', cardCount >= 3, `实际：${cardCount}`)

  // ---------- 2. 主题令牌 ----------
  console.log('\n[2] 主题令牌解析')
  const tokenValues = await page.evaluate(names => {
    const style = getComputedStyle(document.documentElement)
    return names.map(name => [name, style.getPropertyValue(name).trim()])
  }, DSW_TOKENS)
  const missing = tokenValues.filter(([, value]) => value === '')
  check('13 个 --dsw-alias-* 令牌全部有值', missing.length === 0,
    `缺失：${missing.map(([n]) => n).join(', ')}`)

  const cardBg = await page.$eval('[class*="panelCard"]', el => getComputedStyle(el).backgroundColor)
  check('面板卡片背景为令牌色（浅色 #fff）', cardBg === 'rgb(255, 255, 255)', `实际：${cardBg}`)

  const chipBg = await page.$eval('[class*="chipOn"]', el => getComputedStyle(el).backgroundColor).catch(() => '')
  // color-mix 的产物 Chrome 回报为 color(srgb r g b)（0-1 浮点）；旧版 rgb() 也兼容。
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(chipBg)
  const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(chipBg)
  const channels = srgb !== null
    ? srgb.slice(1, 4).map(Number).map(c => Math.round(c * 255))
    : rgb !== null ? rgb.slice(1, 4).map(Number) : []
  check('focus chip 背景为品牌令牌 color-mix 产物（近黑混入白 ≈ rgb(221,222,222)）',
    channels.length === 3 && channels.every(c => c >= 215 && c <= 230),
    `实际：${chipBg}`)

  // ---------- 3. 九视图逐一切换 ----------
  console.log('\n[3] 九视图数据')
  const tabExpectations = [
    ['陈展', '[class*="itemList"] > [class*="item"]', '陈展列表有记忆行'],
    ['走廊', 'svg [class*="_node_"]', '走廊图有节点'],
    ['往事', '[class*="episodeRow"], [class*="episodeHead"]', '往事有时间线行'],
    ['实体', '[class*="episodeRow"]', '实体列表有行'],
    ['信念', '[class*="beliefCard"]', '信念卡有内容'],
    ['日志', '[class*="logRow"]', '日志有行'],
    ['回填', '[class*="backfillMetric"]', '回填有估算数'],
    ['裁决', '[class*="jevStatus"]', '裁决页有状态行'],
  ]
  for (const [label, selector, name] of tabExpectations) {
    await page.click(MAIN_TAB(label))
    await page.waitForTimeout(900)
    const count = await page.$$eval(selector, nodes => nodes.length).catch(() => 0)
    check(name, count > 0, `实际：${count}`)
    const failedTexts = await page.$$eval('[class*="expandLoading"]', nodes =>
      nodes.map(n => n.textContent ?? '').filter(t => t.includes('失败')))
    check(`${label} 视图无加载失败`, failedTexts.length === 0, failedTexts.join('；'))
  }

  // ---------- 4. 陈展交互（详情抽屉 / 编辑 / 软删恢复） ----------
  console.log('\n[4] 陈展交互')
  await page.click(MAIN_TAB('陈展'))
  await page.waitForTimeout(700)
  const itemCount = await page.$$eval('[class*="itemList"] > [class*="item"]', nodes => nodes.length)
  check('陈展有条目', itemCount > 0, `实际：${itemCount}`)

  // 条目操作按钮默认隐藏（原版设计：hover/聚焦才显现）——先 hover 条目再点。
  const firstItem = page.locator('[class*="itemList"] > [class*="item"]').first()
  await firstItem.hover()
  await page.waitForTimeout(250)
  await page.click('[class*="itemList"] > [class*="item"] [class*="itemOps"] button:has-text("参观")')
  await page.waitForTimeout(1000)
  check('详情抽屉打开', await page.$('[role="dialog"]') !== null)
  const attrRows = await page.$$eval('[class*="attrGrid"] dt', nodes => nodes.length)
  check('抽屉属性网格有字段', attrRows >= 6, `实际：${attrRows}`)
  await page.click('[class*="drawerClose"]')
  await page.waitForTimeout(400)

  await firstItem.hover()
  await page.waitForTimeout(250)
  await page.click('[class*="itemList"] > [class*="item"] [class*="itemOps"] button:has-text("修缮")')
  await page.waitForTimeout(500)
  check('编辑表单打开', await page.$('[class*="editForm"]') !== null)
  await page.click('[class*="editForm"] button:has-text("作罢")')
  await page.waitForTimeout(400)

  // 软删语义：封门 → 状态变已闭馆 → 重开恢复
  const activeItem = page.locator('[class*="itemList"] > [class*="item"]:has-text("对外开放")').first()
  check('封门按钮存在（active 条目）', await activeItem.count() > 0)
  if (await activeItem.count() > 0) {
    await activeItem.hover()
    await page.waitForTimeout(250)
    await page.click('[class*="itemList"] > [class*="item"]:has-text("对外开放") [class*="itemOps"] button:has-text("封门")')
    await page.waitForTimeout(1200)
    const hasForgotten = await page.$$eval('[class*="itemList"] [class*="pill"]', nodes =>
      nodes.some(n => n.textContent?.includes('已闭馆')))
    check('封门后出现已闭馆状态（软删语义）', hasForgotten)
    const forgottenItem = page.locator('[class*="itemList"] > [class*="item"]:has-text("已闭馆")').first()
    if (await forgottenItem.count() > 0) {
      await forgottenItem.hover()
      await page.waitForTimeout(250)
      await forgottenItem.locator('[class*="itemOps"] button:has-text("重开")').click()
      await page.waitForTimeout(1200)
      check('重开后回到对外开放', await page.$$eval('[class*="itemList"] [class*="pill"]', nodes =>
        nodes.some(n => n.textContent?.includes('对外开放'))))
    } else {
      check('重开按钮出现（恢复路径可达）', false, '未找到已闭馆条目')
    }
  }

  // ---------- 5. 走廊图谱拖拽 ----------
  console.log('\n[5] 走廊图谱拖拽')
  await page.click(MAIN_TAB('走廊'))
  await page.waitForTimeout(6000) // 等力导向收敛（280 tick ≈ 4.7s）
  const nodeCount = await page.$$eval('svg [class*="_node_"]', nodes => nodes.length)
  check('走廊节点渲染', nodeCount > 0, `实际：${nodeCount}`)
  const edgeCount = await page.$$eval('svg [class*="edgeFade"]', nodes => nodes.length)
  check('走廊边渲染', edgeCount > 0, `实际：${edgeCount}`)
  const legendText = await page.$eval('[class*="legend"]', n => n.textContent ?? '').catch(() => '')
  check('走廊图例含摘要', legendText.includes('走廊'), `实际：${legendText.slice(0, 60)}`)

  if (nodeCount > 0) {
    const readX = async () => page.$eval('svg [class*="_node_"]', el => {
      const m = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(el.getAttribute('transform') ?? '')
      return m === null ? null : Number(m[1])
    })
    const box = await page.$eval('svg [class*="_node_"]', el => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    const beforeX = await readX()
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    await page.mouse.move(box.x + 110, box.y + 70, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const afterX = await readX()
    check('拖拽使节点向右移动 > 40px',
      beforeX !== null && afterX !== null && afterX - beforeX > 40,
      `beforeX=${beforeX} afterX=${afterX}`)
    // 节点 g 带 onClick → onSelect：拖拽的 mouseup 即视为点击，铭牌抽屉应打开
    // （产品行为：点走廊节点看记忆详情）。验证后关闭，避免遮挡后续交互。
    await page.waitForTimeout(300)
    const nodeDrawer = await page.$('[role="dialog"]')
    check('走廊节点点击打开铭牌抽屉', nodeDrawer !== null)
    if (nodeDrawer !== null) {
      const drawerText = await nodeDrawer.textContent() ?? ''
      check('抽屉内容为该记忆的审计视图', drawerText.includes('铭牌') || drawerText.includes('参观'))
      await page.click('[class*="drawerClose"]')
      await page.waitForTimeout(400)
    }
  }

  // ---------- 6. 项目切换 ----------
  console.log('\n[6] 项目切换')
  await page.click('[class*="headerActions"] [class*="segScope"] button:has-text("项目")')
  await page.waitForTimeout(800)
  const wsSelect = await page.$('[class*="wsSelect"]')
  check('项目作用域出现工作区下拉', wsSelect !== null)
  if (wsSelect !== null) {
    const options = await page.$$eval('[class*="wsSelect"] option', nodes => nodes.map(n => n.value))
    const second = options.find(v => v !== 'follow')
    check('工作区下拉有可选分库', second !== undefined, `options=${options.join(',')}`)
    if (second !== undefined) {
      await page.selectOption('[class*="wsSelect"]', second)
      await page.waitForTimeout(600)
      // 当前 tab 还是走廊：切到陈展才能校验列表数据确实换了库
      await page.click(MAIN_TAB('陈展'))
      await page.waitForTimeout(1200)
      const projectContent = await page.$$eval('[class*="itemList"] [class*="content"]', nodes =>
        nodes.map(n => n.textContent ?? ''))
      check('切换项目后陈展重载为项目库数据',
        projectContent.some(t => t.includes('codex/ui') || t.includes('Vite')),
        `实际：${projectContent.slice(0, 2).join(' / ')}`)
      const userLeak = projectContent.some(t => t.includes('hooks 特性已 stable'))
      check('项目库数据不含用户库内容（不串库）', !userLeak)
    }
  }

  // ---------- 7. 语言切换 ----------
  console.log('\n[7] 语言切换')
  await page.click('[class*="langOpt"]:has-text("EN")')
  await page.waitForTimeout(600)
  const enNav = await page.$$eval('[class*="tabs"] [role="tab"]', nodes => nodes.map(n => n.textContent?.trim() ?? ''))
  check('EN 段控生效（Today/Palace/Corridor）',
    enNav.some(t => t.includes('Today')) && enNav.some(t => t.includes('Palace')) && enNav.some(t => t.includes('Corridor')))
  await page.click('[class*="langOpt"]:has-text("中")')
  await page.waitForTimeout(500)

  // ---------- 8. 深浅色切换 ----------
  console.log('\n[8] 深浅色')
  await page.click(MAIN_TAB('今日')) // 陈展 tab 无 panelCard，回今日页取色
  await page.waitForTimeout(900)
  const lightBg = await page.$eval('[class*="panelCard"]', el => getComputedStyle(el).backgroundColor)
  // 初始为 auto（系统浅色 → 显示浅色）：点一次到 light（无视觉变化），再点一次才到 dark。
  await page.click('.appThemeToggle')
  await page.waitForTimeout(300)
  await page.click('.appThemeToggle')
  await page.waitForTimeout(600)
  const themeNow = await page.evaluate(() => document.documentElement.dataset.theme)
  const darkBg = await page.$eval('[class*="panelCard"]', el => getComputedStyle(el).backgroundColor)
  check('主题切换改变 data-theme', themeNow === 'dark', `实际：${themeNow}`)
  check('深色下卡片背景翻转为 #232324', darkBg !== lightBg && darkBg === 'rgb(35, 35, 36)',
    `light=${lightBg} dark=${darkBg}`)
  const darkToken = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-label-primary').trim())
  check('深色令牌生效（label-primary 近白）', darkToken === '#f9fafb', `实际：${darkToken}`)
  // 截图顺序：当前 dark → 拍 dark；再点一次回 auto（系统浅色）→ 拍 light。
  await page.screenshot({ path: join(OUT_DIR, 'd1-today-dark.png') })
  await page.click('.appThemeToggle') // dark → auto（headless 系统为浅色）
  await page.waitForTimeout(600)
  const themeBack = await page.evaluate(() => document.documentElement.dataset.theme)
  check('再切一次回到跟随系统（浅色环境）', themeBack === 'light', `实际：${themeBack}`)

  // ---------- 9. 响应式（窄屏无横向溢出） ----------
  console.log('\n[9] 响应式布局')
  await page.setViewportSize({ width: 480, height: 900 })
  await page.waitForTimeout(600)
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth)
  check('480px 窄屏无横向溢出', overflow <= 1, `实际溢出 ${overflow}px`)
  const narrowTabs = await page.$$eval('[class*="tabs"] [role="tab"]', nodes => nodes.length)
  check('窄屏九 Tab 仍可访问（横向滚动）', narrowTabs === 9, `实际：${narrowTabs}`)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.waitForTimeout(400)

  // 截图顺序：当前 light → 依次拍 今日/陈展/走廊。
  await page.screenshot({ path: join(OUT_DIR, 'd1-today-light.png') })
  await page.click(MAIN_TAB('陈展'))
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT_DIR, 'd1-library.png') })
  await page.click(MAIN_TAB('走廊'))
  await page.waitForTimeout(6000)
  await page.screenshot({ path: join(OUT_DIR, 'd1-corridor.png') })

  await browser.close()

  // ---------- 汇总 ----------
  console.log('\n[汇总]')
  const failed = results.filter(r => !r.ok)
  console.log(`  通过 ${results.length - failed.length}/${results.length}`)
  if (consoleErrors.length > 0) console.log(`  控制台错误 ${consoleErrors.length} 条：`)
  console.log(consoleErrors.map(e => `    - ${e}`).join('\n'))
  console.log(pageErrors.map(e => `    pageerror: ${e}`).join('\n'))
  console.log(failedRequests.map(u => `    失败请求: ${u}`).join('\n'))
  if (failed.length > 0) {
    console.log('  未通过项：')
    console.log(failed.map(r => `    - ${r.name}${r.detail ? `（${r.detail}）` : ''}`).join('\n'))
  }
  if (failed.length > 0 || consoleErrors.length > 0 || pageErrors.length > 0) process.exit(1)
  console.log('  全部通过 ✔')
  process.exit(0)
}

main().catch(error => {
  console.error('[verify] 执行异常：', error)
  process.exit(2)
})
