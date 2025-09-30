import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip = require('adm-zip');

type LogLevel = 'D' | 'I' | 'W' | 'E' | 'T' | 'F';

interface LogMessage {
	index: number;
	timestamp: string; // original string in brackets
	level: LogLevel | string;
	channels: string[];
	text: string; // full message including following lines until next timestamp
}

interface AppSession {
	index: number;
	startLine: number;
	startOffset: number;
	firstMessageTimestamp: string | null;
}

export class LogProvider {
	public static readonly viewType = 'logViewer.view';

	private view?: any;
	private context: any;
	private workspaceFolder: string | null = null;
	private combinedPath: string | null = null;
	private originalCombinedContent: string = ''; // Оригинальный контент для фильтрации
	private parsed: LogMessage[] = [];
	private sessions: AppSession[] = [];
	private channelsTree: Map<string, Set<string>> = new Map();
	private output: vscode.OutputChannel = vscode.window.createOutputChannel('Homescapes Log Viewer');
	private decorationTypes: vscode.TextEditorDecorationType[] = [];
	private documentChangeListener: vscode.Disposable | null = null;

	public constructor(context: any) {
		this.context = context;
	}

	public resolveWebviewView(webviewView: any): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		this.updateHtml();
		webviewView.webview.onDidReceiveMessage(async (msg: any) => {
			switch (msg.type) {
				case 'openFolder':
					await this.handleOpenFolder();
					break;
				case 'applyFilters':
					await this.applyFilters(msg.payload);
					break;
				case 'jumpToSession':
					await this.revealSession(msg.payload?.index);
					break;
				case 'jumpToChannel':
					await this.revealChannel(String(msg.payload?.path || ''));
					break;
			}
		});
	}

	public async handleOpenFolder(): Promise<void> {
		const files = await vscode.window.showOpenDialog({ 
			canSelectFolders: false, 
			canSelectFiles: true, 
			canSelectMany: false,
			filters: { 'Log Files': ['txt'] }
		});
		if (!files || files.length === 0) {
			return;
		}
		const selectedFile = files[0].fsPath;
		this.workspaceFolder = path.dirname(selectedFile);
		await this.combineLogs();
		await this.openCombined();
		// Применяем декорации с небольшой задержкой
		setTimeout(() => {
			this.applyDecorations();
		}, 100);
		this.updateHtml();
	}

	private updateHtml(): void {
		if (!this.view) return;
		const webview = this.view.webview;
		const hasFolder = !!this.workspaceFolder;
		const hasData = !!this.combinedPath;
		const sessions = this.sessions;
		const channelsTree = this.serializeChannelsTree();
		webview.html = this.renderHtml({ hasFolder, hasData, sessions, channelsTree });
		
		// Send initial counts after HTML is loaded
		if (hasData) {
			setTimeout(() => {
				const levelCounts: { [key: string]: number } = { D: 0, I: 0, W: 0, E: 0 };
				for (const msg of this.parsed) {
					if (['D', 'I', 'W', 'E'].includes(String(msg.level))) {
						levelCounts[String(msg.level)]++;
					}
				}
				webview.postMessage({ type: 'matchCount', payload: { count: this.parsed.length, levelCounts } });
			}, 100);
		}
	}

	private renderHtml(data: { hasFolder: boolean; hasData: boolean; sessions: AppSession[]; channelsTree: any }): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html>
		<html lang="ru">
		<head>
			<meta charset="UTF-8" />
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this.view?.webview.cspSource}; script-src 'nonce-${nonce}';" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>Homescapes Log Viewer</title>
			<style>
				body{font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background);}
				.button{padding:6px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:1px solid var(--vscode-button-border, transparent); border-radius:4px; cursor:pointer}
				.button.small{padding:2px 6px; font-size:11px}
				.icon{ cursor:pointer; border:none; background: transparent; color: var(--vscode-foreground); }
				.icon.eye{ width: 22px; height: 22px; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; }
				.icon.eye:hover{ background: var(--vscode-toolbar-hoverBackground); }
				.icon.jump{ width: 22px; height: 22px; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; margin-left:4px; }
				.icon.jump:hover{ background: var(--vscode-toolbar-hoverBackground); }
				.section{margin-top: 10px;}
				details.section{border:1px solid var(--vscode-widget-border); border-radius:6px; background: var(--vscode-editorWidget-background);}
				details.section > summary{padding:6px 10px; font-weight:600; list-style:none; cursor:pointer; background: var(--vscode-sideBarSectionHeader-background); color: var(--vscode-sideBarSectionHeader-foreground); border-bottom:1px solid var(--vscode-widget-border);}
				details.section[open] > summary{border-bottom:1px solid var(--vscode-widget-border);} 
				.panel{padding:8px 10px;}
				.tree{ font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace); font-size: 12px; }
				.tree ul{ list-style:none; padding-left:12px; }
				.tree li{ margin:1px 0; }
				.tree .nodeRow{ display:flex; align-items:center; gap:6px; min-height:18px; }
				.small{opacity:0.8; font-size: 12px;}
				.toggle{ cursor:pointer; user-select:none; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; text-align:center; color: var(--vscode-icon-foreground); }
				.collapsed > ul{ display:none; }
				.input{ width:100%; box-sizing:border-box; padding:6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:4px; }
				.hiddenCheck{ display:none; }
				.sessions .row{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px; border:1px solid var(--vscode-widget-border); border-radius:4px; margin-bottom:4px; background: var(--vscode-editorWidget-background); }
				.sessions .row .left{ display:flex; align-items:center; gap:8px; }
				.level-filters{ display:grid; grid-template-columns: repeat(2, 1fr); gap:8px; margin-bottom:6px; }
				.level-btn{ cursor:pointer; padding:6px 10px; border:2px solid transparent; border-radius:4px; display:flex; align-items:center; gap:6px; user-select:none; transition: all 0.2s; }
				.level-btn input[type="checkbox"]{ margin:0; }
				.level-btn:hover{ opacity:0.85; }
				.level-btn.level-D{ background-color: rgba(79, 193, 255, 0.25); border-color: #4FC1FF; }
				.level-btn.level-I{ background-color: rgba(160, 160, 160, 0.25); border-color: #A0A0A0; }
				.level-btn.level-W{ background-color: rgba(255, 215, 0, 0.25); border-color: #FFD700; }
				.level-btn.level-E{ background-color: rgba(255, 107, 107, 0.25); border-color: #FF6B6B; }
				.level-indicator{ font-family: monospace; font-weight:bold; color: var(--vscode-editor-foreground); }
				.count{ opacity:0.8; font-size:11px; margin-left:auto; }
			</style>
		</head>
		<body>
			<div>
				<button class="button" id="openBtn">Выбрать файл лога</button>
			</div>
			${data.hasData ? `
			<details class="section" open>
				<summary>Запуски</summary>
				<div class="panel">
					<div id="sessions"></div>
				</div>
			</details>
			<details class="section" open>
				<summary>Фильтр</summary>
				<div class="panel">
				<div class="level-filters">
					<label class="level-btn level-D"><input type="checkbox" data-level="D" checked> <span class="level-indicator">[D]</span> debug <span class="count" data-count="D"></span></label>
					<label class="level-btn level-I"><input type="checkbox" data-level="I" checked> <span class="level-indicator">[I]</span> info <span class="count" data-count="I"></span></label>
					<label class="level-btn level-W"><input type="checkbox" data-level="W" checked> <span class="level-indicator">[W]</span> warning <span class="count" data-count="W"></span></label>
					<label class="level-btn level-E"><input type="checkbox" data-level="E" checked> <span class="level-indicator">[E]</span> error <span class="count" data-count="E"></span></label>
				</div>
					<input id="textFilter" type="text" placeholder="Введите текст" class="input" />
					<div class="small" id="matchCount" style="margin-top:4px"></div>
				</div>
			</details>
			<details class="section" open>
				<summary>Каналы</summary>
				<div class="panel">
					<div style="display:flex; gap:8px; align-items:center; margin-bottom:6px">
						<button id="rootEye" class="icon eye" title="Видимость всех каналов"></button>
						<span style="white-space:nowrap">Все каналы</span>
						<input id="channelFilter" type="text" placeholder="Фильтр каналов" class="input" style="margin:0" />
					</div>
					<div class="tree" id="channelsTree"></div>
				</div>
			</details>
			` : ''}
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				document.getElementById('openBtn').addEventListener('click', ()=>{
					vscode.postMessage({ type: 'openFolder' });
				});
				const hasData = ${data.hasData ? 'true' : 'false'};
				if (hasData){
					const channelsData = ${JSON.stringify(data.channelsTree)};
					const sessions = ${JSON.stringify(data.sessions)};
					const clone = (obj)=>JSON.parse(JSON.stringify(obj));
					// Handle messages from extension
					window.addEventListener('message', event => {
						const message = event.data;
						if (message.type === 'matchCount') {
							const countEl = document.getElementById('matchCount');
							if (countEl) {
								countEl.textContent = 'Найдено совпадений: ' + message.payload.count;
							}
							if (message.payload.levelCounts) {
								const counts = message.payload.levelCounts;
								for (const level of ['D', 'I', 'W', 'E']) {
									const countSpan = document.querySelector('[data-count="' + level + '"]');
									if (countSpan && counts[level] !== undefined) {
										countSpan.textContent = '(' + counts[level] + ')';
									}
								}
							}
						}
					});
					const filterTree = (node, query)=>{
						if (!query) return clone(node);
						const q = query.toLowerCase();
						const walk=(n)=>{
							let out={};
							for(const k of Object.keys(n)){
								const child = walk(n[k]);
								if (k.toLowerCase().includes(q) || Object.keys(child).length){
									out[k]=child;
								}
							}
							return out;
						};
						return walk(node);
					};
					const channelsTreeDiv = document.getElementById('channelsTree');
					// состояние видимости каналов
					const selected = new Set();
					const collectVisible=()=>{ selected.clear(); document.querySelectorAll('input[data-channel].hiddenCheck:checked').forEach(i=>selected.add(i.getAttribute('data-channel'))); };
					const restoreVisible=()=>{ document.querySelectorAll('input[data-channel].hiddenCheck').forEach(i=>{ const id=i.getAttribute('data-channel'); i.checked = selected.size===0 ? true : selected.has(id); }); };
					const eyeOpenSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
					const eyeClosedSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/><path d="M1 12s4-7 11-7c2.2 0 4.1.6 5.6 1.4M23 12s-4 7-11 7c-2.2 0-4.1-.6-5.6-1.4" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
					// управление root eye
					const rootEye = document.getElementById('rootEye');
					let rootVisible = true;
					const setRootEye=()=>{ rootEye.innerHTML = rootVisible ? eyeOpenSvg : eyeClosedSvg; };
					setRootEye();
					rootEye.addEventListener('click', ()=>{
						rootVisible = !rootVisible; setRootEye();
						document.querySelectorAll('input[data-channel].hiddenCheck').forEach(function(c){ c.checked = rootVisible; });
						apply();
					});
					const renderTree=(node, container, path=[])=>{
						const ul=document.createElement('ul');
						const keys = Object.keys(node).sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:'base', numeric:true}));
						for(const key of keys){
							const li=document.createElement('li');
							const row=document.createElement('div');
							row.className='nodeRow';
							const id = [...path, key].join('>');
							const hasChildren = Object.keys(node[key]).length > 0;
							const depth = path.length + 1; // 1 = первый уровень
							let toggleEl=null;
							if (hasChildren){
								toggleEl=document.createElement('span');
								toggleEl.className='toggle';
								toggleEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2"/></svg>';
								row.appendChild(toggleEl);
							} else {
								const spacer=document.createElement('span');
								spacer.className='toggle';
								row.appendChild(spacer);
							}
							// скрытый чекбокс для логики
							const cb=document.createElement('input');
							cb.type='checkbox';
							cb.className='hiddenCheck';
							cb.setAttribute('data-channel', id);
							cb.checked = selected.size===0 ? true : selected.has(id);
							row.appendChild(cb);
							// иконка глаз
							const eye=document.createElement('button');
							eye.className='icon eye';
							eye.title='Видимость канала';
							const setEye=()=>{ eye.innerHTML = cb.checked ? eyeOpenSvg : eyeClosedSvg; };
							setEye();
							eye.addEventListener('click', ()=>{ cb.checked=!cb.checked; setEye(); apply(); });
							row.appendChild(eye);
							// подпись
							const label=document.createElement('span');
							label.textContent = key;
							row.appendChild(label);
							// кнопка перехода
							const jump=document.createElement('button');
							jump.className='icon jump';
							jump.title='Перейти к первому сообщению';
							jump.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" stroke-width="2"/></svg>';
							jump.addEventListener('click', ()=>{ vscode.postMessage({ type:'jumpToChannel', payload: { path: id } }); });
							row.appendChild(jump);
							li.appendChild(row);
							if (hasChildren){
								renderTree(node[key], li, [...path, key]);
								// Сворачивание по умолчанию: глубже первого уровня
								if (depth > 1){ li.classList.add('collapsed'); }
								if (toggleEl){
									const updateIcon=()=>{
										const collapsed = li.classList.contains('collapsed');
										toggleEl.innerHTML = collapsed
											? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2"/></svg>'
											: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2"/></svg>';
									};
									updateIcon();
									toggleEl.addEventListener('click', ()=>{ li.classList.toggle('collapsed'); updateIcon(); });
								}
							}
							ul.appendChild(li);
						}
						container.appendChild(ul);
					};
					const apply=()=>{
						collectVisible();
						const levels=[...document.querySelectorAll('input[data-level]')].filter(i=>i.checked).map(i=>i.getAttribute('data-level'));
						const channels=[...document.querySelectorAll('input[data-channel].hiddenCheck')].filter(i=>i.checked).map(i=>i.getAttribute('data-channel'));
						const sessionsSel=[...document.querySelectorAll('input[data-session]')].filter(i=>i.checked).map(i=>Number(i.getAttribute('data-session')));
						const text=(document.getElementById('textFilter')).value || '';
						vscode.postMessage({ type:'applyFilters', payload:{ levels, channels, sessions: sessionsSel, text }});
					};
					const rerenderChannels=()=>{
						collectVisible();
						channelsTreeDiv.innerHTML='';
						const q=(document.getElementById('channelFilter')||{value:''}).value;
						const filtered = filterTree(channelsData, q);
						renderTree(filtered, channelsTreeDiv);
						restoreVisible();
						// Перевесим обработчики для новых скрытых чекбоксов каналов
						document.querySelectorAll('input[data-channel].hiddenCheck').forEach(inp=>inp.addEventListener('change', apply));
					};
					rerenderChannels();
					const sessionsDiv = document.getElementById('sessions');
					sessionsDiv.className = 'sessions';
					sessionsDiv.innerHTML='';
					sessions.forEach(s=>{
						const row=document.createElement('div');
						row.className='row';
						const left=document.createElement('div');
						left.className='left';
						const label=document.createElement('label');
						label.innerHTML = '<input type="checkbox" data-session="' + s.index + '" checked> #' + s.index + ' — ' + (s.firstMessageTimestamp ?? 'n/a');
						left.appendChild(label);
						row.appendChild(left);
						const btn=document.createElement('button');
						btn.className='icon jump';
						btn.title='Открыть запуск';
						btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" stroke-width="2"/></svg>';
						btn.setAttribute('data-jump', String(s.index));
						row.appendChild(btn);
						sessionsDiv.appendChild(row);
					});
					// обработчики кнопок перехода по сессии
					document.querySelectorAll('button[data-jump]').forEach(btn=>{
						btn.addEventListener('click', ()=>{ vscode.postMessage({ type:'jumpToSession', payload: { index: Number(btn.getAttribute('data-jump')) }}); });
					});
					// обработчики фильтров
					document.querySelectorAll('input[data-level],input[data-session]').forEach(inp=>inp.addEventListener('change', apply));
					document.getElementById('textFilter').addEventListener('input', apply);
					document.getElementById('channelFilter').addEventListener('input', rerenderChannels);
					const rootCb = document.getElementById('rootChannel');
					if (rootCb){
						rootCb.addEventListener('change', ()=>{
							var checked = false;
							if (rootCb && 'checked' in rootCb) { checked = rootCb.checked; }
							document.querySelectorAll('input[data-channel].hiddenCheck').forEach(function(c){ c.checked = checked; });
							apply();
						});
					}
				}
			</script>
		</body>
		</html>`;
	}

	private serializeChannelsTree(): any {
		// Convert Map hierarchy like 'VSO>ResourceManagement>...' to nested object
		const root: any = {};
		for (const [parent, children] of this.channelsTree.entries()) {
			const parts = parent.split('>');
			let node = root;
			for (const p of parts) {
				if (!node[p]) node[p] = {};
				node = node[p];
			}
			for (const child of children) {
				if (!node[child]) node[child] = {};
			}
		}
		return root;
	}

	private async combineLogs(): Promise<void> {
		if (!this.workspaceFolder) return;
		const dir = this.workspaceFolder;
		const files = fs.readdirSync(dir).filter((f: string) => f === 'log.txt' || /^log\.history\d+\.txt\.zip$/.test(f));
		// Требуемый порядок: текущий log.txt, затем history по возрастанию N
		const history = files.filter((f: string) => f.startsWith('log.history')).sort((a: string, b: string)=>{
			const na = Number(a.match(/history(\d+)/)?.[1] ?? 0);
			const nb = Number(b.match(/history(\d+)/)?.[1] ?? 0);
			return na - nb;
		});
		const combinedParts: string[] = [];
		const currentLogPath = path.join(dir, 'log.txt');
		if (fs.existsSync(currentLogPath)) {
			combinedParts.push(`\n===== BEGIN PART: log.txt =====\n` + fs.readFileSync(currentLogPath, 'utf8') + `\n===== END PART: log.txt =====\n`);
		}
		for (const z of history) {
			const zip = new AdmZip(path.join(dir, z));
			const entry = zip.getEntry('log.txt');
			if (entry) {
				const content = zip.readAsText(entry, 'utf8');
				combinedParts.push(`\n===== BEGIN PART: ${z}::log.txt =====\n` + content + `\n===== END PART: ${z}::log.txt =====\n`);
			}
		}
		const combined = combinedParts.join('\n');
		this.originalCombinedContent = combined; // Сохраняем оригинал
		const outDir = path.join(dir);
		const outPath = path.join(outDir, 'combined_logs.txt');
		fs.writeFileSync(outPath, combined, 'utf8');
		this.combinedPath = outPath;
		this.parseCombined(combined);
	}

	private parseCombined(content: string): void {
		this.parsed = [];
		this.sessions = [];
		this.channelsTree.clear();
		// Очистим вывод перед новым парсингом
		this.output.clear();
		const lines = content.split(/\r?\n/);
		const startRegex = /^================== APP STARTED =================/;
		const headPrefixRegex = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\[(.)\]/;
		let current: LogMessage | null = null;
		let index = 0;
		let sessionIndex = 0;
		let currentLineInOriginal = 0; // Счетчик строк в оригинальном файле
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (startRegex.test(line)) {
				this.sessions.push({ 
					index: ++sessionIndex, 
					startLine: currentLineInOriginal, 
					startOffset: index, 
					firstMessageTimestamp: null 
				});
				currentLineInOriginal++;
				continue;
			}
			const m = line.match(headPrefixRegex);
			if (m) {
				if (current) {
					this.parsed.push(current);
				}
				const timestamp = m[1];
				const level = m[2];
				let rest = line.slice(m[0].length);
				// Пропускаем пробелы
				rest = rest.replace(/^\s+/, '');
				// Игнорируем (WorkingQueue:N)
				const wq = rest.match(/^\(WorkingQueue:(\d+)\)/);
				if (wq) {
					rest = rest.slice(wq[0].length);
					rest = rest.replace(/^\s+/, '');
				}
				// Парсим каналы до первого не '['
				const channels: string[] = [];
				while (true) {
					rest = rest.replace(/^\s+/, '');
					if (!rest.startsWith('[')) break;
					const end = rest.indexOf(']');
					if (end <= 1) { break; }
					const ch = rest.slice(1, end);
					// Доп. защита: каналы не содержат пробелы или кавычки
					if (/\s|['"]/g.test(ch)) { break; }
					channels.push(ch);
					rest = rest.slice(end + 1);
				}
				const textHead = rest.trimStart();
				current = { index: index++, timestamp, level, channels, text: textHead };

				// Лог: строка и распарсенные каналы
				this.output.appendLine(`line ${i + 1}: ${channels.length ? channels.join('>') : '(none)'}`);

				// fill sessions' first ts if missing
				if (this.sessions.length > 0) {
					const last = this.sessions[this.sessions.length - 1];
					if (!last.firstMessageTimestamp) last.firstMessageTimestamp = timestamp;
				}

				// Строим дерево каналов: добавляем только непосредственного потомка к каждому префиксу
				if (channels.length > 1) {
					for (let k = 0; k < channels.length - 1; k++) {
						const parentPath = channels.slice(0, k + 1).join('>');
						if (!this.channelsTree.has(parentPath)) this.channelsTree.set(parentPath, new Set<string>());
						this.channelsTree.get(parentPath)!.add(channels[k + 1]);
					}
				}
				else {
					// no channels — уже зафиксировано общей строкой выше
				}
				currentLineInOriginal++;
			}
			else if (current) {
				current.text += (current.text ? '\n' : '') + line;
				currentLineInOriginal++;
			} else {
				currentLineInOriginal++;
			}
		}
		if (current) this.parsed.push(current);
		// Итоговую статистику не выводим, чтобы не засорять лог
	}

	private async openCombined(): Promise<void> {
		if (!this.combinedPath) return;
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
	}

	private async applyFilters(payload: { levels: string[]; channels: string[]; sessions: number[]; text: string }): Promise<void> {
		if (!this.combinedPath || !this.originalCombinedContent) return;
		const levelSet = new Set(payload.levels);
		const text = (payload.text ?? '').toLowerCase();
		const allowedChannels = new Set(payload.channels);
		const allowedSessions = new Set(payload.sessions);
		
		// Определяем какой сессии принадлежит сообщение
		const sessionByIndex = (idx: number): number => {
			let sid = 0;
			for (const s of this.sessions) {
				if (idx >= s.startOffset) sid = s.index; else break;
			}
			return sid;
		};
		
		// Создаем Set индексов разрешенных сообщений для быстрого поиска
		const allowedMessageIndices = new Set<number>();
		const levelCounts: { [key: string]: number } = { D: 0, I: 0, W: 0, E: 0 };
		
		for (const msg of this.parsed) {
			// Подсчет всех сообщений по уровню
			if (['D', 'I', 'W', 'E'].includes(String(msg.level))) {
				levelCounts[String(msg.level)]++;
			}
			
			// Фильтр по уровню: применяется только к известным уровням
			const knownLevels = ['D', 'I', 'W', 'E'];
			const hasKnownLevel = knownLevels.includes(String(msg.level));
			if (hasKnownLevel && !levelSet.has(String(msg.level))) {
				continue;
			}
			
			// Фильтр по каналам: применяется только если у сообщения есть каналы
			const pathStr = msg.channels.join('>');
			const hasChannels = msg.channels.length > 0;
			if (hasChannels) {
				let channelOk = true;
				for (let i = 0; i < msg.channels.length; i++) {
					const prefix = msg.channels.slice(0, i + 1).join('>');
					if (!allowedChannels.has(prefix)) {
						channelOk = false;
						break;
					}
				}
				if (!channelOk) continue;
			}
			
			// Фильтр по сессии
			const sid = sessionByIndex(msg.index);
			if (!allowedSessions.has(sid)) continue;
			
			// Фильтр по тексту
			if (text && (msg.text.toLowerCase().indexOf(text) === -1 && pathStr.toLowerCase().indexOf(text) === -1)) continue;
			
			allowedMessageIndices.add(msg.index);
		}
		
		// Теперь построим файл из оригинального контента, включая все строки
		const lines = this.originalCombinedContent.split(/\r?\n/);
		const startRegex = /^================== APP STARTED =================/;
		const partRegex = /^===== (BEGIN|END) PART:/;
		const headPrefixRegex = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\[(.)\]/;
		const outputLines: string[] = [];
		
		let currentMessageIndex = -1;
		let includeCurrentMessage = false;
		
		for (const line of lines) {
			// Служебные строки всегда включаем (разделители сессий и частей)
			if (startRegex.test(line) || partRegex.test(line)) {
				outputLines.push(line);
				continue;
			}
			
			// Проверяем начало нового сообщения
			const m = line.match(headPrefixRegex);
			if (m) {
				currentMessageIndex++;
				includeCurrentMessage = allowedMessageIndices.has(currentMessageIndex);
			}
			
			// Включаем строку если текущее сообщение разрешено
			if (includeCurrentMessage) {
				outputLines.push(line);
			}
		}
		
		const out = outputLines.join('\n');
		fs.writeFileSync(this.combinedPath, out, 'utf8');
		
		// Обновим документ и применим декорации
		await this.reloadAndDecorate();
		
		// Обновляем счетчики
		if (this.view) {
			this.view.webview.postMessage({ type: 'matchCount', payload: { count: allowedMessageIndices.size, levelCounts } });
		}
	}

	private async reloadAndDecorate(): Promise<void> {
		if (!this.combinedPath) return;
		
		// Закрываем документ если он открыт
		const existingDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.combinedPath);
		if (existingDoc && existingDoc.isDirty) {
			await existingDoc.save();
		}
		
		// Открываем документ заново
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
		
		// Применяем декорации после того как документ точно обновился
		// Используем небольшую задержку для надежности
		setTimeout(() => {
			this.applyDecorations();
		}, 50);
	}

	private async revealSession(sessionIndex: number): Promise<void> {
		if (!this.combinedPath) return;
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		// find line of APP STARTED #index in original combined (after filters it may not exist)
		// as a heuristic, search for the first message of that session
		const s = this.sessions.find(s => s.index === sessionIndex);
		if (!s || !this.parsed[s.startOffset]) return;
		const ts = this.parsed[s.startOffset].timestamp;
		const text = doc.getText();
		const pos = text.indexOf(`[${ts}]`);
		if (pos >= 0) {
			const start = doc.positionAt(pos);
			editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
		}
	}

	private async revealChannel(pathStr: string): Promise<void> {
		if (!this.combinedPath || !pathStr) return;
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		const needle = ' ' + pathStr.split('>').map(c=>`[${c}]`).join(' ');
		const text = doc.getText();
		const pos = text.indexOf(needle);
		if (pos >= 0) {
			const start = doc.positionAt(pos);
			const end = doc.positionAt(pos + needle.length);
			editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
			// Выделим найденный диапазон
			editor.selections = [new vscode.Selection(start, end)];
			// Мягко сбросим выделение через короткую задержку, чтобы не мешать работе
			setTimeout(()=>{ editor.selections = [new vscode.Selection(start, start)]; }, 800);
		}
	}

	private applyDecorations(): void {
		const editor = vscode.window.visibleTextEditors.find((e: vscode.TextEditor) => e.document.uri.fsPath === this.combinedPath);
		if (!editor) {
			// Listen for when the document is opened
			const listener = vscode.window.onDidChangeVisibleTextEditors(() => {
				this.applyDecorations();
				listener.dispose();
			});
			return;
		}

		// Очистим старые декорации
		this.decorationTypes.forEach(dt => dt.dispose());
		this.decorationTypes = [];

		const text = editor.document.getText();
		const lines = text.split(/\r?\n/);

		// Define decoration types с более яркими цветами
		const dateDecorationType = vscode.window.createTextEditorDecorationType({
			color: '#9B9B9B'
		});
		const levelDDecorationType = vscode.window.createTextEditorDecorationType({
			color: '#4FC1FF',
			fontWeight: 'bold'
		});
		const levelIDecorationType = vscode.window.createTextEditorDecorationType({
			color: '#A0A0A0',
			fontWeight: 'bold'
		});
		const levelWDecorationType = vscode.window.createTextEditorDecorationType({
			color: '#FFD700',
			fontWeight: 'bold'
		});
		const levelEDecorationType = vscode.window.createTextEditorDecorationType({
			color: '#FF6B6B',
			fontWeight: 'bold'
		});
		const channelDecorationType = vscode.window.createTextEditorDecorationType({
			color: '#DA70D6'
		});

		// Сохраняем ссылки для очистки
		this.decorationTypes.push(dateDecorationType, levelDDecorationType, levelIDecorationType, 
			levelWDecorationType, levelEDecorationType, channelDecorationType);

		const dateRanges: vscode.Range[] = [];
		const levelDRanges: vscode.Range[] = [];
		const levelIRanges: vscode.Range[] = [];
		const levelWRanges: vscode.Range[] = [];
		const levelERanges: vscode.Range[] = [];
		const channelRanges: vscode.Range[] = [];

		const lineRegex = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\[(.)\]/;
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = line.match(lineRegex);
			if (match) {
				// Highlight date
				const dateStart = line.indexOf('[') + 1;
				const dateEnd = dateStart + match[1].length;
				dateRanges.push(new vscode.Range(i, dateStart, i, dateEnd));

				// Highlight level
				const levelStart = line.indexOf('][') + 2;
				const levelEnd = levelStart + 1;
				const level = match[2];
				switch (level) {
					case 'D':
						levelDRanges.push(new vscode.Range(i, levelStart, i, levelEnd));
						break;
					case 'I':
						levelIRanges.push(new vscode.Range(i, levelStart, i, levelEnd));
						break;
					case 'W':
						levelWRanges.push(new vscode.Range(i, levelStart, i, levelEnd));
						break;
					case 'E':
						levelERanges.push(new vscode.Range(i, levelStart, i, levelEnd));
						break;
				}

				// Highlight channels
				let rest = line.slice(match[0].length).trim();
				let currentPos = match[0].length;
				while (rest.startsWith('[')) {
					// Skip whitespace
					while (currentPos < line.length && /\s/.test(line[currentPos])) {
						currentPos++;
					}
					if (line[currentPos] !== '[') break;
					
					const endBracket = rest.indexOf(']');
					if (endBracket <= 1) break;
					
					const channelText = rest.slice(1, endBracket);
					// Check if it's a valid channel (no spaces or quotes)
					if (/\s|['"]/g.test(channelText)) break;
					
					const channelStart = currentPos;
					const channelEnd = currentPos + endBracket + 1;
					channelRanges.push(new vscode.Range(i, channelStart, i, channelEnd));
					
					currentPos = channelEnd;
					rest = rest.slice(endBracket + 1).trim();
				}
			}
		}

		// Применяем декорации только если редактор все еще видим
		if (vscode.window.visibleTextEditors.includes(editor)) {
			editor.setDecorations(dateDecorationType, dateRanges);
			editor.setDecorations(levelDDecorationType, levelDRanges);
			editor.setDecorations(levelIDecorationType, levelIRanges);
			editor.setDecorations(levelWDecorationType, levelWRanges);
			editor.setDecorations(levelEDecorationType, levelERanges);
			editor.setDecorations(channelDecorationType, channelRanges);
		}
	}
}


