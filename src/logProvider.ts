import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip = require('adm-zip');

/**
 * LogProvider - провайдер для просмотра и фильтрации логов Homescapes
 * 
 * Структура кода:
 * 1. HTML Generation Functions - генерация HTML интерфейса
 * 2. Data Processing Functions - обработка и фильтрация данных
 * 3. Log Reading and Parsing Functions - чтение и парсинг логов
 * 4. Filter Handling Functions - обработка фильтров
 * 5. Navigation Functions - навигация по логу
 * 6. Syntax Highlighting Functions - подсветка синтаксиса
 */

type LogLevel = 'D' | 'I' | 'W' | 'E' | '!' | '' | 'T' | 'F';

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
	private channelColors: Map<string, string> = new Map(); // Цвета для каналов
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

	// ==================== HTML Generation Functions ====================

	/**
	 * Генерация HTML списка запусков
	 */
	private generateSessionsHtml(sessions: AppSession[]): string {
		return `
			<details class="section" open>
				<summary>Запуски</summary>
				<div class="panel">
					<div id="sessions"></div>
				</div>
			</details>`;
	}

	/**
	 * Генерация HTML фильтров важности сообщений и фильтра текста
	 */
	private generateFiltersHtml(): string {
		return `
			<details class="section" open>
				<summary>Фильтр</summary>
				<div class="panel">
				<div class="level-filters">
					<div class="level-btn level-HALT">
						<input type="checkbox" class="styledCheck" data-level="!" checked title="Видимость halt">
						<button class="icon solo" data-level-solo="!" title="Только halt">S</button>
						<span class="level-indicator">[!]</span> halt <span class="count" data-count="!"></span>
					</div>
					<div class="level-btn level-E">
						<input type="checkbox" class="styledCheck" data-level="E" checked title="Видимость error">
						<button class="icon solo" data-level-solo="E" title="Только error">S</button>
						<span class="level-indicator">[E]</span> error <span class="count" data-count="E"></span>
					</div>
					<div class="level-btn level-W">
						<input type="checkbox" class="styledCheck" data-level="W" checked title="Видимость warning">
						<button class="icon solo" data-level-solo="W" title="Только warning">S</button>
						<span class="level-indicator">[W]</span> warning <span class="count" data-count="W"></span>
					</div>
					<div class="level-btn level-I">
						<input type="checkbox" class="styledCheck" data-level="I" checked title="Видимость info">
						<button class="icon solo" data-level-solo="I" title="Только info">S</button>
						<span class="level-indicator">[I]</span> info <span class="count" data-count="I"></span>
					</div>
					<div class="level-btn level-D">
						<input type="checkbox" class="styledCheck" data-level="D" checked title="Видимость debug">
						<button class="icon solo" data-level-solo="D" title="Только debug">S</button>
						<span class="level-indicator">[D]</span> debug <span class="count" data-count="D"></span>
					</div>
					<div class="level-btn level-NONE">
						<input type="checkbox" class="styledCheck" data-level="" checked title="Видимость none">
						<button class="icon solo" data-level-solo="" title="Только none">S</button>
						<span class="level-indicator">[ ]</span> none <span class="count" data-count=""></span>
					</div>
				</div>
					<input id="textFilter" type="text" placeholder="Введите текст" class="input" />
					<div class="small" id="matchCount" style="margin-top:4px"></div>
				</div>
			</details>`;
	}

	/**
	 * Генерация HTML дерева каналов
	 */
	private generateChannelsTreeHtml(): string {
		return `
			<details class="section" open>
				<summary>Каналы</summary>
				<div class="panel">
					<div style="display:flex; gap:8px; align-items:center; margin-bottom:6px">
						<input id="rootEye" type="checkbox" class="styledCheck" checked title="Видимость всех каналов">
						<span style="white-space:nowrap">Все каналы</span>
						<input id="channelFilter" type="text" placeholder="Фильтр каналов" class="input" style="margin:0" />
					</div>
					<div class="tree" id="channelsTree"></div>
				</div>
			</details>`;
	}

	/**
	 * Генерация CSS стилей
	 */
	private generateStyles(): string {
		return `
				body{font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background);}
				.button{padding:6px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:1px solid var(--vscode-button-border, transparent); border-radius:4px; cursor:pointer}
				.button.small{padding:2px 6px; font-size:11px}
				.icon{ cursor:pointer; border:none; background: transparent; color: var(--vscode-foreground); }
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
				.styledCheck{ 
					appearance: none;
					width: 14px; 
					height: 14px; 
					min-width: 14px;
					min-height: 14px;
					border: 2px solid #A0A0A0; 
					border-radius: 3px; 
					cursor: pointer; 
					margin: 0;
					flex-shrink: 0;
					background: transparent;
					position: relative;
					transition: all 0.15s ease;
				}
				.styledCheck:hover{ 
					border-color: #C0C0C0;
				}
				.styledCheck:checked{ 
					background: #C0C0C0;
					border-color: #C0C0C0;
				}
				.styledCheck:checked::before{ 
					content: '';
					position: absolute;
					left: 3px;
					top: 0px;
					width: 3px;
					height: 7px;
					border: solid #FFFFFF;
					border-width: 0 2px 2px 0;
					transform: rotate(45deg);
				}
				.dimmed{ opacity: 0.6; }
				.sessions .row{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px; border:1px solid var(--vscode-widget-border); border-radius:4px; margin-bottom:4px; background: var(--vscode-editorWidget-background); }
				.sessions .row .left{ display:flex; align-items:center; gap:8px; }
				.icon.solo{ width: 20px; height: 20px; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; font-size:11px; font-weight:bold; }
				.icon.solo:hover{ background: var(--vscode-toolbar-hoverBackground); }
				.level-filters{ display:grid; grid-template-columns: repeat(2, 1fr); gap:8px; margin-bottom:6px; }
				.level-btn{ padding:6px 10px; border:2px solid transparent; border-radius:4px; display:flex; align-items:center; gap:4px; user-select:none; transition: all 0.2s; }
				.level-btn:hover{ opacity:0.85; }
				.level-btn.level-HALT{ background-color: rgba(101, 67, 33, 0.5); border-color: rgba(101, 67, 33, 0.8); }
				.level-btn.level-E{ background-color: rgba(255, 0, 0, 1.0); border-color: rgba(255, 0, 0, 1.0); }
				.level-btn.level-W{ background-color: rgba(204, 204, 0, 0.7); border-color: rgba(204, 204, 0, 0.9); }
				.level-btn.level-I{ background-color: rgba(160, 160, 160, 0.3); border-color: rgba(160, 160, 160, 0.5); }
				.level-btn.level-D{ background-color: rgba(79, 193, 255, 0.3); border-color: rgba(79, 193, 255, 0.5); }
				.level-btn.level-NONE{ background-color: rgba(255, 255, 255, 0.5); border-color: rgba(255, 255, 255, 0.8); }
				.level-indicator{ font-family: monospace; font-weight:bold; color: var(--vscode-editor-foreground); }
				.count{ opacity:0.8; font-size:11px; margin-left:auto; }`;
	}

	/**
	 * Генерация JavaScript для веб-вью
	 */
	private generateScript(data: { hasData: boolean; sessions: AppSession[]; channelsTree: any; channelColors: any }, nonce: string): string {
		return `<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				const hasData = ${data.hasData ? 'true' : 'false'};
				if (hasData){
					const channelsData = ${JSON.stringify(data.channelsTree)};
					const sessions = ${JSON.stringify(data.sessions)};
					const channelColors = ${JSON.stringify(data.channelColors)};
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
								for (const level of ['D', 'I', 'W', 'E', '!', '']) {
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
					const collectVisible=()=>{ selected.clear(); document.querySelectorAll('input[data-channel].styledCheck:checked').forEach(i=>selected.add(i.getAttribute('data-channel'))); };
					const restoreVisible=()=>{ document.querySelectorAll('input[data-channel].styledCheck').forEach(i=>{ const id=i.getAttribute('data-channel'); i.checked = selected.size===0 ? true : selected.has(id); }); };
					// управление root checkbox
					const rootEye = document.getElementById('rootEye');
					rootEye.addEventListener('click', (e)=>{
						e.stopPropagation(); // Останавливаем всплытие события
					});
					rootEye.addEventListener('change', ()=>{
						const rootVisible = rootEye.checked;
						document.querySelectorAll('input[data-channel].styledCheck').forEach(function(c){ 
							c.checked = rootVisible; 
							c.style.opacity = '1'; // Все видны, если все включены/выключены
							
							// Обновляем приглушение
							const channelLi = c.closest('li');
							if(channelLi){
								if(rootVisible) channelLi.classList.remove('dimmed');
								else channelLi.classList.add('dimmed');
							}
						});
						apply();
					});
					const renderTree=(node, container, path=[])=>{
						const ul=document.createElement('ul');
						// Сортируем ключи, но "(без канала)" всегда первый
						const keys = Object.keys(node).sort((a,b)=>{
							if(a === '(без канала)') return -1;
							if(b === '(без канала)') return 1;
							return a.localeCompare(b, undefined, {sensitivity:'base', numeric:true});
						});
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
							// Чекбокс для видимости канала
							const cb=document.createElement('input');
							cb.type='checkbox';
							cb.className='styledCheck';
							cb.setAttribute('data-channel', id);
							cb.checked = selected.size===0 ? true : selected.has(id);
							cb.title='Видимость канала';
							
							// Проверка, включены ли все родители
							const checkParentsEnabled=()=>{
								// Для специального канала "(без канала)" не проверяем родителей
								if(id === '(без канала)') return true;
								
								const parts = id.split('>');
								for(let i = 0; i < parts.length - 1; i++){
									const parentPath = parts.slice(0, i + 1).join('>');
									const parentCb = document.querySelector('input[data-channel="' + parentPath + '"].styledCheck');
									if(parentCb && !parentCb.checked) return false;
								}
								return true;
							};
							
							// Полупрозрачность чекбокса если родители выключены
							cb.style.opacity = checkParentsEnabled() ? '1' : '0.3';
							
							// Приглушение строки если выключен или родитель выключен
							const updateRowDim = ()=>{
								if(!cb.checked || !checkParentsEnabled()){
									li.classList.add('dimmed');
								} else {
									li.classList.remove('dimmed');
								}
							};
							updateRowDim();
							
							cb.addEventListener('change', ()=>{ 
								// Если канал включается, включаем всех детей рекурсивно
								if(cb.checked){
									document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
										const channelId = c.getAttribute('data-channel');
										if(channelId && channelId.startsWith(id + '>')){
											c.checked = true;
										}
									});
								}
								
								// Обновляем прозрачность и приглушение для всех дочерних каналов
								document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
									const channelId = c.getAttribute('data-channel');
									if(channelId && channelId.startsWith(id + '>')){
										const checkP = ()=>{
											if(channelId === '(без канала)') return true;
											const parts = channelId.split('>');
											for(let i = 0; i < parts.length - 1; i++){
												const parentPath = parts.slice(0, i + 1).join('>');
												const parentCb = document.querySelector('input[data-channel="' + parentPath + '"].styledCheck');
												if(parentCb && !parentCb.checked) return false;
											}
											return true;
										};
										c.style.opacity = checkP() ? '1' : '0.3';
										
										// Обновляем приглушение строки дочернего канала
										const childLi = c.closest('li');
										if(childLi){
											if(!c.checked || !checkP()){
												childLi.classList.add('dimmed');
											} else {
												childLi.classList.remove('dimmed');
											}
										}
									}
								});
								
								updateRowDim();
								apply(); 
							});
							row.appendChild(cb);
							
							// Кнопка solo
							const soloBtn=document.createElement('button');
							soloBtn.className='icon solo';
							soloBtn.title='Только этот канал';
							soloBtn.textContent = 'S';
							soloBtn.addEventListener('click', ()=>{
								// Выключаем все каналы
								document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ c.checked = false; });
								
								// Включаем этот канал
								cb.checked = true;
								
								// Включаем всех родителей (только если не "(без канала)")
								if(id !== '(без канала)'){
									const parts = id.split('>');
									for(let i = 0; i < parts.length - 1; i++){
										const parentPath = parts.slice(0, i + 1).join('>');
										const parentCb = document.querySelector('input[data-channel="' + parentPath + '"].styledCheck');
										if(parentCb) parentCb.checked = true;
									}
								}
								
								// Включаем всех детей (и детей детей рекурсивно)
								document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{
									const channelId = c.getAttribute('data-channel');
									if(channelId && channelId.startsWith(id + '>')){
										c.checked = true;
									}
								});
								
								// Обновляем прозрачность и приглушение всех чекбоксов
								document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
									const channelId = c.getAttribute('data-channel');
									const checkP = ()=>{
										if(channelId === '(без канала)') return true;
										const parts = channelId.split('>');
										for(let i = 0; i < parts.length - 1; i++){
											const parentPath = parts.slice(0, i + 1).join('>');
											const parentCb = document.querySelector('input[data-channel="' + parentPath + '"].styledCheck');
											if(parentCb && !parentCb.checked) return false;
										}
										return true;
									};
									c.style.opacity = checkP() ? '1' : '0.3';
									
									// Обновляем приглушение строки
									const channelLi = c.closest('li');
									if(channelLi){
										if(!c.checked || !checkP()){
											channelLi.classList.add('dimmed');
										} else {
											channelLi.classList.remove('dimmed');
										}
									}
								});
								
								apply();
							});
							row.appendChild(soloBtn);
							
							// подпись с цветом
							const label=document.createElement('span');
							label.textContent = key;
							const channelColor = channelColors[id];
							if (channelColor) {
								label.style.color = channelColor;
							}
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
						
						// Обновляем прозрачность и приглушение всех чекбоксов каналов
						document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
							const channelId = c.getAttribute('data-channel');
							if(channelId){
								const checkParents = ()=>{
									// Для специального канала "(без канала)" не проверяем родителей
									if(channelId === '(без канала)') return true;
									
									const parts = channelId.split('>');
									for(let i = 0; i < parts.length - 1; i++){
										const parentPath = parts.slice(0, i + 1).join('>');
										const parentCb = document.querySelector('input[data-channel="' + parentPath + '"].styledCheck');
										if(parentCb && !parentCb.checked) return false;
									}
									return true;
								};
								c.style.opacity = checkParents() ? '1' : '0.3';
								
								// Обновляем приглушение строки канала
								const channelLi = c.closest('li');
								if(channelLi){
									if(!c.checked || !checkParents()){
										channelLi.classList.add('dimmed');
									} else {
										channelLi.classList.remove('dimmed');
									}
								}
							}
						});
						
						const levels=[...document.querySelectorAll('input[data-level].styledCheck')].filter(i=>i.checked).map(i=>i.getAttribute('data-level'));
						const channels=[...document.querySelectorAll('input[data-channel].styledCheck')].filter(i=>i.checked).map(i=>i.getAttribute('data-channel'));
						const sessionsSel=[...document.querySelectorAll('input[data-session].styledCheck')].filter(i=>i.checked).map(i=>Number(i.getAttribute('data-session')));
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
						
						// Обновляем прозрачность и приглушение всех чекбоксов после перерисовки
						document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
							const channelId = c.getAttribute('data-channel');
							if(channelId){
								const checkParents = ()=>{
									// Для специального канала "(без канала)" не проверяем родителей
									if(channelId === '(без канала)') return true;
									
									const parts = channelId.split('>');
									for(let i = 0; i < parts.length - 1; i++){
										const parentPath = parts.slice(0, i + 1).join('>');
										const parentCb = document.querySelector('input[data-channel="' + parentPath + '"].styledCheck');
										if(parentCb && !parentCb.checked) return false;
									}
									return true;
								};
								c.style.opacity = checkParents() ? '1' : '0.3';
								
								// Обновляем приглушение строки канала
								const channelLi = c.closest('li');
								if(channelLi){
									if(!c.checked || !checkParents()){
										channelLi.classList.add('dimmed');
									} else {
										channelLi.classList.remove('dimmed');
									}
								}
							}
						});
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
						
						// Чекбокс для видимости запуска
						const cb=document.createElement('input');
						cb.type='checkbox';
						cb.className='styledCheck';
						cb.setAttribute('data-session', String(s.index));
						cb.checked = true;
						cb.title='Видимость запуска';
						cb.addEventListener('change', ()=>{
							if(cb.checked) row.classList.remove('dimmed');
							else row.classList.add('dimmed');
							apply();
						});
						left.appendChild(cb);
						
						// Кнопка solo
						const soloBtn=document.createElement('button');
						soloBtn.className='icon solo';
						soloBtn.title='Только этот запуск';
						soloBtn.textContent = 'S';
						soloBtn.addEventListener('click', ()=>{
							document.querySelectorAll('.sessions .row').forEach(function(r, idx){
								const sessionCb = r.querySelector('input[data-session].styledCheck');
								if(sessionCb){
									const isCurrent = sessionCb.getAttribute('data-session') === String(s.index);
									sessionCb.checked = isCurrent;
									if(isCurrent) r.classList.remove('dimmed');
									else r.classList.add('dimmed');
								}
							});
							apply();
						});
						left.appendChild(soloBtn);
						
						const label=document.createElement('span');
						label.textContent = '#' + s.index + ' — ' + (s.firstMessageTimestamp ?? 'n/a');
						left.appendChild(label);
						row.appendChild(left);
						
						const right=document.createElement('div');
						right.style.display='flex';
						right.style.gap='4px';
						
						// Кнопка перехода
						const btn=document.createElement('button');
						btn.className='icon jump';
						btn.title='Открыть запуск';
						btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" stroke-width="2"/></svg>';
						btn.setAttribute('data-jump', String(s.index));
						btn.addEventListener('click', ()=>{ vscode.postMessage({ type:'jumpToSession', payload: { index: Number(btn.getAttribute('data-jump')) }}); });
						right.appendChild(btn);
						
						row.appendChild(right);
						sessionsDiv.appendChild(row);
					});
					
					// обработчики фильтров уровней
					document.querySelectorAll('input[data-level].styledCheck').forEach(cb=>{
						const updateDim = ()=>{
							const parent = cb.closest('.level-btn');
							if(parent){
								if(cb.checked) parent.classList.remove('dimmed');
								else parent.classList.add('dimmed');
							}
						};
						updateDim(); // Начальное состояние
						cb.addEventListener('change', ()=>{
							updateDim();
							apply();
						});
					});
					
					// Обработчики кнопок solo для уровней
					document.querySelectorAll('[data-level-solo]').forEach(soloBtn=>{
						soloBtn.addEventListener('click', ()=>{
							const targetLevel = soloBtn.getAttribute('data-level-solo');
							// Выключаем все уровни, включаем только выбранный
							document.querySelectorAll('input[data-level].styledCheck').forEach(cb=>{
								const cbLevel = cb.getAttribute('data-level');
								cb.checked = (cbLevel === targetLevel);
								// Обновляем приглушение
								const parent = cb.closest('.level-btn');
								if(parent){
									if(cb.checked) parent.classList.remove('dimmed');
									else parent.classList.add('dimmed');
								}
							});
							apply();
						});
					});
					
					// Debounce для текстового фильтра
					let textFilterTimeout = null;
					document.getElementById('textFilter').addEventListener('input', ()=>{
						if(textFilterTimeout) clearTimeout(textFilterTimeout);
						textFilterTimeout = setTimeout(apply, 900);
					});
					
					// Debounce для фильтра каналов
					let channelFilterTimeout = null;
					document.getElementById('channelFilter').addEventListener('input', ()=>{
						if(channelFilterTimeout) clearTimeout(channelFilterTimeout);
						channelFilterTimeout = setTimeout(rerenderChannels, 900);
					});
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
			</script>`;
	}

	/**
	 * Обновление HTML интерфейса
	 */
	private updateHtml(): void {
		if (!this.view) return;
		const webview = this.view.webview;
		const hasFolder = !!this.workspaceFolder;
		const hasData = !!this.combinedPath;
		const sessions = this.sessions;
		const channelsTree = this.serializeChannelsTree();
		const channelColors = Object.fromEntries(this.channelColors.entries());
		webview.html = this.renderHtml({ hasFolder, hasData, sessions, channelsTree, channelColors });
		
		// Send initial counts after HTML is loaded
		if (hasData) {
			setTimeout(() => {
				const levelCounts = this.calculateLevelCounts();
				webview.postMessage({ type: 'matchCount', payload: { count: this.parsed.length, levelCounts } });
			}, 100);
		}
	}

	/**
	 * Основной рендеринг HTML страницы
	 */
	private renderHtml(data: { hasFolder: boolean; hasData: boolean; sessions: AppSession[]; channelsTree: any; channelColors: any }): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html>
		<html lang="ru">
		<head>
			<meta charset="UTF-8" />
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this.view?.webview.cspSource}; script-src 'nonce-${nonce}';" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>Homescapes Log Viewer</title>
			<style>
${this.generateStyles()}
			</style>
		</head>
		<body>
			${data.hasData ? this.generateSessionsHtml(data.sessions) : ''}
			${data.hasData ? this.generateFiltersHtml() : ''}
			${data.hasData ? this.generateChannelsTreeHtml() : ''}
			${this.generateScript(data, nonce)}
		</body>
		</html>`;
	}

	// ==================== Data Processing Functions ====================

	/**
	 * Подсчет количества сообщений по уровням важности
	 */
	private calculateLevelCounts(): { [key: string]: number } {
		const levelCounts: { [key: string]: number } = { '!': 0, E: 0, W: 0, I: 0, D: 0, '': 0 };
		for (const msg of this.parsed) {
			if (['!', 'E', 'W', 'I', 'D', ''].includes(String(msg.level))) {
				levelCounts[String(msg.level)]++;
			}
		}
		return levelCounts;
	}

	/**
	 * Генерация цвета для канала по его имени
	 */
	private getChannelColor(channelPath: string): string {
		if (!this.channelColors.has(channelPath)) {
			// Используем хэш строки для генерации стабильного цвета
			let hash = 0;
			for (let i = 0; i < channelPath.length; i++) {
				hash = channelPath.charCodeAt(i) + ((hash << 5) - hash);
			}
			const h = Math.abs(hash % 360);
			const s = 65; // Насыщенность
			const l = 75; // Яркость (увеличена для более светлых цветов)
			this.channelColors.set(channelPath, `hsl(${h}, ${s}%, ${l}%)`);
		}
		return this.channelColors.get(channelPath)!;
	}

	/**
	 * Определение сессии по индексу сообщения
	 */
	private getSessionByMessageIndex(idx: number): number {
		let sid = 0;
		for (const s of this.sessions) {
			if (idx >= s.startOffset) sid = s.index; else break;
		}
		return sid;
	}

	/**
	 * Фильтрация сообщений с учетом всех фильтров
	 */
	private filterMessages(payload: { levels: string[]; channels: string[]; sessions: number[]; text: string }): Set<number> {
		const levelSet = new Set(payload.levels);
		const text = (payload.text ?? '').toLowerCase();
		const allowedChannels = new Set(payload.channels);
		const allowedSessions = new Set(payload.sessions);
		
		const allowedMessageIndices = new Set<number>();
		
		// Проверяем, включен ли специальный канал "(без канала)"
		const noChannelAllowed = allowedChannels.has('(без канала)');
		
		for (const msg of this.parsed) {
			// Фильтр по уровню: применяется только к известным уровням
			const knownLevels = ['!', 'E', 'W', 'I', 'D', ''];
			const hasKnownLevel = knownLevels.includes(String(msg.level));
			if (hasKnownLevel && !levelSet.has(String(msg.level))) {
				continue;
			}
			
			// Фильтр по каналам
			const pathStr = msg.channels.join('>');
			const hasChannels = msg.channels.length > 0;
			
			if (hasChannels) {
				// Сообщение с каналами - проверяем разрешенные каналы
				let channelOk = true;
				for (let i = 0; i < msg.channels.length; i++) {
					const prefix = msg.channels.slice(0, i + 1).join('>');
					if (!allowedChannels.has(prefix)) {
						channelOk = false;
						break;
					}
				}
				if (!channelOk) continue;
			} else {
				// Сообщение без каналов - проверяем, разрешен ли специальный канал
				if (!noChannelAllowed) continue;
			}
			
			// Фильтр по сессии
			const sid = this.getSessionByMessageIndex(msg.index);
			if (!allowedSessions.has(sid)) continue;
			
			// Фильтр по тексту
			if (text && (msg.text.toLowerCase().indexOf(text) === -1 && pathStr.toLowerCase().indexOf(text) === -1)) continue;
			
			allowedMessageIndices.add(msg.index);
		}
		
		return allowedMessageIndices;
	}

	/**
	 * Сериализация дерева каналов для передачи в веб-вью
	 */
	private serializeChannelsTree(): any {
		// Convert Map hierarchy like 'VSO>ResourceManagement>...' to nested object
		const root: any = {};
		
		// Добавляем специальный канал "(без канала)" первым
		// Проверяем, есть ли сообщения без каналов
		const hasNoChannelMessages = this.parsed.some(msg => msg.channels.length === 0);
		if (hasNoChannelMessages) {
			root['(без канала)'] = {};
			// Генерируем цвет для специального канала
			this.getChannelColor('(без канала)');
		}
		
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

	// ==================== Log Reading and Parsing Functions ====================

	private async combineLogs(): Promise<void> {
		if (!this.workspaceFolder) return;
		const dir = this.workspaceFolder;
		const files = fs.readdirSync(dir).filter((f: string) => f === 'log.txt' || /^log\.history\d+\.txt\.zip$/.test(f));
		// Требуемый порядок: history от большего к меньшему, затем log.txt
		const history = files.filter((f: string) => f.startsWith('log.history')).sort((a: string, b: string)=>{
			const na = Number(a.match(/history(\d+)/)?.[1] ?? 0);
			const nb = Number(b.match(/history(\d+)/)?.[1] ?? 0);
			return nb - na; // По убыванию (от большего к меньшему)
		});
		const combinedParts: string[] = [];
		
		// Сначала добавляем history файлы от большего к меньшему
		for (const z of history) {
			const zip = new AdmZip(path.join(dir, z));
			const entry = zip.getEntry('log.txt');
			if (entry) {
				const content = zip.readAsText(entry, 'utf8');
				combinedParts.push(`\n===== BEGIN PART: ${z}::log.txt =====\n` + content + `\n===== END PART: ${z}::log.txt =====\n`);
			}
		}
		
		// Затем добавляем текущий log.txt
		const currentLogPath = path.join(dir, 'log.txt');
		if (fs.existsSync(currentLogPath)) {
			combinedParts.push(`\n===== BEGIN PART: log.txt =====\n` + fs.readFileSync(currentLogPath, 'utf8') + `\n===== END PART: log.txt =====\n`);
		}
		
		const combined = combinedParts.join('\n');
		this.originalCombinedContent = combined; // Сохраняем оригинал
		const outDir = path.join(dir);
		const outPath = path.join(outDir, 'combined_logs.txt');
		fs.writeFileSync(outPath, combined, 'utf8');
		this.combinedPath = outPath;
		this.parseCombined(combined);
	}

	/**
	 * Чтение и парсинг логов
	 */
	private parseCombined(content: string): void {
		this.parsed = [];
		this.sessions = [];
		this.channelsTree.clear();
		this.channelColors.clear();
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
				// И генерируем цвета для каждого канала
				if (channels.length > 0) {
					for (let k = 0; k < channels.length; k++) {
						const channelPath = channels.slice(0, k + 1).join('>');
						// Генерируем цвет для каждого уровня пути
						this.getChannelColor(channelPath);
						
						// Добавляем в дерево
						if (k < channels.length - 1) {
							if (!this.channelsTree.has(channelPath)) {
								this.channelsTree.set(channelPath, new Set<string>());
							}
							this.channelsTree.get(channelPath)!.add(channels[k + 1]);
						}
					}
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

	// ==================== Filter Handling Functions ====================

	/**
	 * Обработка применения фильтров
	 */
	private async applyFilters(payload: { levels: string[]; channels: string[]; sessions: number[]; text: string }): Promise<void> {
		if (!this.combinedPath || !this.originalCombinedContent) return;
		
		// Фильтруем сообщения
		const allowedMessageIndices = this.filterMessages(payload);
		
		// Генерируем комбинированный лог с учетом фильтров
		const filteredContent = this.generateCombinedLog(allowedMessageIndices);
		
		// Записываем в файл
		fs.writeFileSync(this.combinedPath, filteredContent, 'utf8');
		
		// Обновим документ и применим декорации
		await this.reloadAndDecorate();
		
		// Обновляем счетчики
		if (this.view) {
			const levelCounts = this.calculateLevelCounts();
			this.view.webview.postMessage({ type: 'matchCount', payload: { count: allowedMessageIndices.size, levelCounts } });
		}
	}

	/**
	 * Генерация комбинированного лога с фильтрацией
	 * - Компилирует части лога с учетом фильтрации выключенных сообщений
	 * - Все что не выключено - добавляется
	 */
	private generateCombinedLog(allowedMessageIndices: Set<number>): string {
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
		
		return outputLines.join('\n');
	}

	// ==================== Navigation Functions ====================

	/**
	 * Обработка перехода к запуску
	 */
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

	/**
	 * Обработка перехода к каналу
	 */
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

	/**
	 * Перезагрузка документа и применение декораций
	 */
	private async reloadAndDecorate(): Promise<void> {
		if (!this.combinedPath) return;
		
		// Закрываем все редакторы с этим документом
		const existingDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.combinedPath);
		if (existingDoc) {
			// Закрываем редактор
			await vscode.window.showTextDocument(existingDoc, { preview: false });
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
		
		// Небольшая пауза для полного закрытия
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Открываем документ заново
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
		
		// Ждем пока документ точно загрузится
		await new Promise(resolve => setTimeout(resolve, 150));
		
		// Применяем декорации
		this.applyDecorations();
	}

	// ==================== Syntax Highlighting Functions ====================

	/**
	 * Генерация подсветки синтаксиса лога
	 */
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

		// Мапа для декораций каналов по цветам
		const channelDecorationsByColor = new Map<string, { type: vscode.TextEditorDecorationType; ranges: vscode.Range[] }>();

		// Define decoration types с фоном (без фиксированного цвета текста)
		const dateDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(155, 155, 155, 0.2)'
		});
		const levelHaltDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(101, 67, 33, 0.5)' // темно-коричневый
		});
		const levelEDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 0, 0, 1.0)' // чисто красный
		});
		const levelWDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(204, 204, 0, 0.7)' // темно желтый
		});
		const levelIDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(160, 160, 160, 0.3)'
		});
		const levelDDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(79, 193, 255, 0.3)'
		});
		const levelNoneDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 255, 255, 0.5)' // белый
		});

		// Сохраняем ссылки для очистки
		this.decorationTypes.push(dateDecorationType, levelHaltDecorationType, levelEDecorationType, levelWDecorationType, 
			levelIDecorationType, levelDDecorationType, levelNoneDecorationType);

		const dateRanges: vscode.Range[] = [];
		const levelHaltRanges: vscode.Range[] = [];
		const levelERanges: vscode.Range[] = [];
		const levelWRanges: vscode.Range[] = [];
		const levelIRanges: vscode.Range[] = [];
		const levelDRanges: vscode.Range[] = [];
		const levelNoneRanges: vscode.Range[] = [];

		const lineRegex = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\[([ !DIWETF])\]/;
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = line.match(lineRegex);
			if (match) {
				// Highlight date с скобками
				const dateStartBracket = line.indexOf('[');
				const dateEndBracket = dateStartBracket + 1 + match[1].length + 1;
				dateRanges.push(new vscode.Range(i, dateStartBracket, i, dateEndBracket));

				// Highlight level с скобками
				const levelStartBracket = line.indexOf('][') + 1; // +1 чтобы начать с '['
				const levelEndBracket = levelStartBracket + 3; // '[' + символ + ']' = 3 символа
				const level = match[2];
				const levelRange = new vscode.Range(i, levelStartBracket, i, levelEndBracket);
				
				switch (level) {
					case '!':
						levelHaltRanges.push(levelRange);
						break;
					case 'E':
						levelERanges.push(levelRange);
						break;
					case 'W':
						levelWRanges.push(levelRange);
						break;
					case 'I':
						levelIRanges.push(levelRange);
						break;
					case 'D':
						levelDRanges.push(levelRange);
						break;
					case ' ':
					case '':
						levelNoneRanges.push(levelRange);
						break;
				}

				// Highlight channels с разными цветами
				let rest = line.slice(match[0].length).trim();
				let currentPos = match[0].length;
				const channelPath: string[] = [];
				
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
					
					channelPath.push(channelText);
					const fullPath = channelPath.join('>');
					const color = this.getChannelColor(fullPath);
					
					// Создаем или используем существующий тип декорации для этого цвета
					if (!channelDecorationsByColor.has(color)) {
						const decorationType = vscode.window.createTextEditorDecorationType({
							backgroundColor: color.replace('hsl', 'hsla').replace(')', ', 0.3)')
						});
						this.decorationTypes.push(decorationType);
						channelDecorationsByColor.set(color, { type: decorationType, ranges: [] });
					}
					
					const channelStart = currentPos;
					const channelEnd = currentPos + endBracket + 1;
					channelDecorationsByColor.get(color)!.ranges.push(new vscode.Range(i, channelStart, i, channelEnd));
					
					currentPos = channelEnd;
					rest = rest.slice(endBracket + 1).trim();
				}
			}
		}

		// Применяем декорации только если редактор все еще видим
		if (vscode.window.visibleTextEditors.includes(editor)) {
			editor.setDecorations(dateDecorationType, dateRanges);
			editor.setDecorations(levelHaltDecorationType, levelHaltRanges);
			editor.setDecorations(levelEDecorationType, levelERanges);
			editor.setDecorations(levelWDecorationType, levelWRanges);
			editor.setDecorations(levelIDecorationType, levelIRanges);
			editor.setDecorations(levelDDecorationType, levelDRanges);
			editor.setDecorations(levelNoneDecorationType, levelNoneRanges);
			
			// Применяем декорации каналов
			for (const { type, ranges } of channelDecorationsByColor.values()) {
				editor.setDecorations(type, ranges);
			}
		}
	}
}


