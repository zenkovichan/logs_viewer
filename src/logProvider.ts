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

interface StateTransition {
	messageIndex: number;
	timestamp: string;
	from: string;
	to: string;
}

interface AppSession {
	index: number;
	startLine: number;
	startOffset: number;
	firstMessageTimestamp: string | null;
	buildVersion?: string | null;
	transitions?: StateTransition[];
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
	private tsToIndices: Map<string, number[]> = new Map();
	private transitionMessageIndices: Set<number> = new Set();
	private lastDecoratedVersion: number = -1; // Версия документа, к которой применены декорации
	private decorationTimeout: NodeJS.Timeout | null = null; // Таймаут для дебаунса
	private isApplyingDecorations: boolean = false; // Флаг процесса применения

	public constructor(context: any) {
		this.context = context;
		this.context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection(() => {
				this.handleSelectionChange();
			}),
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				// Применяем декорации когда combined_logs.txt становится видимым
				this.applyDecorationsIfNeeded();
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// Если изменился combined_logs.txt, переприменяем декорации
				if (this.combinedPath && event.document.uri.fsPath === this.combinedPath) {
					this.scheduleDecorationsReapply();
				}
			})
		);
	}
	
	/**
	 * Планирует повторное применение декораций с дебаунсом
	 */
	private scheduleDecorationsReapply(): void {
		if (this.decorationTimeout) {
			clearTimeout(this.decorationTimeout);
		}
		this.decorationTimeout = setTimeout(() => {
			this.applyDecorationsIfNeeded();
		}, 500); // Ждем 500ms после последнего изменения
	}
	
	/**
	 * Применяет декорации если открыт combined_logs.txt и они еще не применены
	 */
	private applyDecorationsIfNeeded(): void {
		if (!this.combinedPath || this.isApplyingDecorations) return;
		
		const editor = vscode.window.visibleTextEditors.find(
			(e: vscode.TextEditor) => e.document.uri.fsPath === this.combinedPath
		);
		
		if (!editor) return;
		
		// Проверяем, нужно ли обновлять декорации
		const currentVersion = editor.document.version;
		if (this.lastDecoratedVersion === currentVersion && this.decorationTypes.length > 0) {
			// Декорации уже применены к этой версии документа
			return;
		}
		
		// Даем время на загрузку документа
		setTimeout(() => {
			this.applyDecorations();
		}, 100);
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
				case 'jumpToTransition':
					await this.revealTransition(Number(msg.payload?.messageIndex));
					break;
			}
		});
	}

	public async handleOpenFolder(): Promise<void> {
		const overallStart = Date.now();
		this.output.clear();
		this.output.appendLine('=== Начало обработки логов ===');
		
		const files = await vscode.window.showOpenDialog({ 
			canSelectFolders: false, 
			canSelectFiles: true, 
			canSelectMany: false,
			filters: { 'Log Files': ['txt', 'zip'] }
		});
		if (!files || files.length === 0) {
			return;
		}
		const selectedFile = files[0].fsPath;
		this.workspaceFolder = path.dirname(selectedFile);
		
		// Сохраняем информацию о выбранном файле
		const selectedFileName = path.basename(selectedFile);
		const isZipFile = selectedFileName.toLowerCase().endsWith('.zip');
		
		this.output.appendLine(`Выбран файл: ${selectedFileName}`);
		
		await this.combineLogs(isZipFile ? selectedFile : null);
		
		this.output.appendLine('');
		this.output.appendLine('📄 Открытие документа...');
		const openStart = Date.now();
		await this.openCombined();
		const openTime = Date.now() - openStart;
		this.output.appendLine(`⏱ Открытие документа: ${openTime}ms`);
		
		// Применяем декорации с небольшой задержкой
		setTimeout(() => {
			const decorationsStart = Date.now();
			this.applyDecorations();
			const decorationsTime = Date.now() - decorationsStart;
			this.output.appendLine(`⏱ Применение декораций: ${decorationsTime}ms`);
		}, 100);
		
		this.output.appendLine('');
		this.output.appendLine('🎨 Обновление интерфейса...');
		const htmlStart = Date.now();
		this.updateHtml();
		const htmlTime = Date.now() - htmlStart;
		this.output.appendLine(`⏱ Обновление HTML: ${htmlTime}ms`);
		
		const overallTime = Date.now() - overallStart;
		this.output.appendLine(`=== Общее время обработки: ${overallTime}ms (${(overallTime / 1000).toFixed(2)}s) ===`);
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
				.count{ opacity:0.8; font-size:11px; margin-left:auto; }
				.sessions .row .left .dot{ width:8px; height:8px; border-radius:50%; background:transparent; border:1px solid transparent; display:inline-block; }
				.sessions .row .left .dot.active{ background:#ff3b30; border-color:#ff3b30; }
				.sessions .session-node .children{ overflow:hidden; transition: max-height 0.2s ease-out; }
				.sessions .session-node .children.collapsed{ display:none; }
				.sessions ul.transitions{ list-style:none; padding-left:20px; margin:4px 0 0; }
				.sessions li.transition-row{ display:flex; align-items:center; gap:8px; padding:2px 0; }
				.sessions li.transition-row .dot{ width:6px; height:6px; border-radius:50%; background:transparent; border:1px solid transparent; display:inline-block; }
				.sessions li.transition-row .dot.active{ background:#ff3b30; border-color:#ff3b30; }
				.sessions li.transition-row .transition-jump{ background:transparent; border:none; color: var(--vscode-foreground); cursor:pointer; text-align:left; padding:0; }
				.sessions .icon.toggle-transitions{ width: 20px; height: 20px; display:inline-flex; align-items:center; justify-content:center; border-radius:3px; transition: transform 0.2s ease; }
				.sessions .icon.toggle-transitions:hover{ background: var(--vscode-toolbar-hoverBackground); }
				.sessions .icon.toggle-transitions.collapsed{ transform: rotate(-90deg); }
				`;
	}

	/**
	 * Генерация JavaScript для веб-вью
	 */
	private generateScript(data: { hasData: boolean; sessions: AppSession[]; channelsTree: any; channelColors: any }, nonce: string): string {
		let channelsDataJson = '{}';
		let sessionsJson = '[]';
		let channelColorsJson = '{}';
		
		if (data.hasData) {
			const jsonStart1 = Date.now();
			channelsDataJson = JSON.stringify(data.channelsTree);
			this.output.appendLine(`      ⏱ JSON.stringify(channelsTree): ${Date.now() - jsonStart1}ms (${(channelsDataJson.length / 1024).toFixed(2)} KB)`);
			
			const jsonStart2 = Date.now();
			sessionsJson = JSON.stringify(data.sessions);
			this.output.appendLine(`      ⏱ JSON.stringify(sessions): ${Date.now() - jsonStart2}ms (${(sessionsJson.length / 1024).toFixed(2)} KB)`);
			
			const jsonStart3 = Date.now();
			channelColorsJson = JSON.stringify(data.channelColors);
			this.output.appendLine(`      ⏱ JSON.stringify(channelColors): ${Date.now() - jsonStart3}ms (${(channelColorsJson.length / 1024).toFixed(2)} KB)`);
		}
		
		return `<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				const hasData = ${data.hasData ? 'true' : 'false'};
				if (hasData){
					const channelsData = ${channelsDataJson};
					const sessions = ${sessionsJson};
					const channelColors = ${channelColorsJson};
					const clone = (obj)=>JSON.parse(JSON.stringify(obj));
					let activeLocation = null; // { sessionIndex, transitionMessageIndex? }
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
						} else if (message.type === 'activeLocation') {
							activeLocation = message.payload || null;
							updateActiveDots();
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
					
					// Независимое хранилище состояния каналов (true = включен, false = выключен)
					const channelStates = new Map();
					
					// Инициализация всех каналов как включенных
					const initializeChannelStates = () => {
						for(const channelPath in channelColors){
							if(!channelStates.has(channelPath)){
								channelStates.set(channelPath, true);
							}
						}
						// Добавляем специальный канал
						if(!channelStates.has('(без канала)')){
							channelStates.set('(без канала)', true);
						}
					};
					initializeChannelStates();
					
					// Получить все дочерние пути канала
					const getAllChildPaths = (parentPath) => {
						const children = [];
						for(const key in channelColors){
							if(key.startsWith(parentPath + '>')){
								children.push(key);
							}
						}
						return children;
					};
					
					// Установить состояние канала и всех его детей
					const setChannelState = (channelPath, state) => {
						channelStates.set(channelPath, state);
						const children = getAllChildPaths(channelPath);
						children.forEach(childPath => {
							channelStates.set(childPath, state);
						});
					};
					
					// Получить состояние канала
					const getChannelState = (channelPath) => {
						return channelStates.has(channelPath) ? channelStates.get(channelPath) : true;
					};
					
					// Получить список активных каналов для фильтрации
					const getActiveChannels = () => {
						const active = [];
						for(const [path, state] of channelStates.entries()){
							if(state) active.push(path);
						}
						return active;
					};
					// управление root checkbox
					const rootEye = document.getElementById('rootEye');
					rootEye.addEventListener('click', (e)=>{
						e.stopPropagation(); // Останавливаем всплытие события
					});
					rootEye.addEventListener('change', ()=>{
						const rootVisible = rootEye.checked;
						
						// Обновляем состояние всех каналов
						for(const channelPath of channelStates.keys()){
							channelStates.set(channelPath, rootVisible);
						}
						
						// Обновляем DOM
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
							cb.checked = getChannelState(id);
							cb.title='Видимость канала';
							
							// Проверка, включены ли все родители (по состоянию, а не по DOM)
							const checkParentsEnabled=()=>{
								// Для специального канала "(без канала)" не проверяем родителей
								if(id === '(без канала)') return true;
								
								const parts = id.split('>');
								for(let i = 0; i < parts.length - 1; i++){
									const parentPath = parts.slice(0, i + 1).join('>');
									if(!getChannelState(parentPath)) return false;
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
								// Обновляем состояние канала и всех его детей в Map
								setChannelState(id, cb.checked);
								
								// Обновляем DOM для видимых элементов
								document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
									const channelId = c.getAttribute('data-channel');
									if(channelId){
										// Обновляем чекбокс если это дочерний канал
										if(channelId.startsWith(id + '>')){
											c.checked = getChannelState(channelId);
										}
										
										// Обновляем прозрачность (проверка родителей)
										const checkP = ()=>{
											if(channelId === '(без канала)') return true;
											const parts = channelId.split('>');
											for(let i = 0; i < parts.length - 1; i++){
												const parentPath = parts.slice(0, i + 1).join('>');
												if(!getChannelState(parentPath)) return false;
											}
											return true;
										};
										c.style.opacity = checkP() ? '1' : '0.3';
										
										// Обновляем приглушение строки
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
								// Выключаем все каналы в Map
								for(const channelPath of channelStates.keys()){
									channelStates.set(channelPath, false);
								}
								
								// Включаем этот канал и всех его детей
								setChannelState(id, true);
								
								// Включаем всех родителей (только если не "(без канала)")
								if(id !== '(без канала)'){
									const parts = id.split('>');
									for(let i = 0; i < parts.length - 1; i++){
										const parentPath = parts.slice(0, i + 1).join('>');
										channelStates.set(parentPath, true);
									}
								}
								
								// Обновляем DOM для всех видимых каналов
								document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{
									const channelId = c.getAttribute('data-channel');
									if(channelId){
										c.checked = getChannelState(channelId);
										
										// Обновляем прозрачность
										const checkP = ()=>{
											if(channelId === '(без канала)') return true;
											const parts = channelId.split('>');
											for(let i = 0; i < parts.length - 1; i++){
												const parentPath = parts.slice(0, i + 1).join('>');
												if(!getChannelState(parentPath)) return false;
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
										if(!getChannelState(parentPath)) return false;
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
						const channels=getActiveChannels(); // Берем из Map вместо DOM
						const sessionsSel=[...document.querySelectorAll('input[data-session].styledCheck')].filter(i=>i.checked).map(i=>Number(i.getAttribute('data-session')));
						const text=(document.getElementById('textFilter')).value || '';
						vscode.postMessage({ type:'applyFilters', payload:{ levels, channels, sessions: sessionsSel, text }});
					};
					const rerenderChannels=()=>{
						// Перерисовываем дерево
						channelsTreeDiv.innerHTML='';
						const q=(document.getElementById('channelFilter')||{value:''}).value;
						const filtered = filterTree(channelsData, q);
						renderTree(filtered, channelsTreeDiv);
						
						// После перерисовки обновляем прозрачность и приглушение
						document.querySelectorAll('input[data-channel].styledCheck').forEach(c=>{ 
							const channelId = c.getAttribute('data-channel');
							if(channelId){
								const checkParents = ()=>{
									// Для специального канала "(без канала)" не проверяем родителей
									if(channelId === '(без канала)') return true;
									
									const parts = channelId.split('>');
									for(let i = 0; i < parts.length - 1; i++){
										const parentPath = parts.slice(0, i + 1).join('>');
										if(!getChannelState(parentPath)) return false;
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
					
					const renderSessions = () => {
						sessionsDiv.innerHTML='';
						sessions.forEach(s=>{
							const node=document.createElement('div');
							node.className='session-node';
							node.setAttribute('data-session-index', String(s.index));
						const row=document.createElement('div');
						row.className='row';
					const left=document.createElement('div');
					left.className='left';
					
					// Дочерние переходы состояний
					const transitions = Array.isArray(s.transitions) ? s.transitions : [];
					
					// Кнопка toggle для переходов (только если есть переходы) - в самом начале
					let toggleBtn = null;
					if (transitions.length > 0) {
						toggleBtn=document.createElement('button');
						toggleBtn.className='icon toggle-transitions collapsed';
						toggleBtn.title='Показать/скрыть переходы состояний';
						toggleBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2"/></svg>';
						left.appendChild(toggleBtn);
					}
					
					const dot=document.createElement('span');
					dot.className='dot';
					left.appendChild(dot);
					
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
						
						const labelContainer=document.createElement('div');
						labelContainer.style.display='flex';
						labelContainer.style.flexDirection='column';
						labelContainer.style.gap='2px';
						
						const label=document.createElement('span');
						label.textContent = '#' + s.index + ' — ' + (s.firstMessageTimestamp ?? 'n/a');
						labelContainer.appendChild(label);
						
						// Добавляем Build version если есть
						if(s.buildVersion){
							const buildLabel=document.createElement('span');
							buildLabel.textContent = 'Build: ' + s.buildVersion;
							buildLabel.style.fontSize = '11px';
							buildLabel.style.opacity = '0.8';
							labelContainer.appendChild(buildLabel);
						}
						
						left.appendChild(labelContainer);
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
							node.appendChild(row);

							// Создаем блок с переходами
							if (transitions.length > 0){
								const children = document.createElement('div');
								children.className = 'children collapsed'; // По умолчанию свернуто
								const list = document.createElement('ul');
								list.className = 'transitions';
								transitions.forEach(tr=>{
									const li = document.createElement('li');
									li.className = 'transition-row';
									li.setAttribute('data-transition-msg', String(tr.messageIndex));
									const d = document.createElement('span');
									d.className = 'dot';
									li.appendChild(d);
									const text = document.createElement('button');
									text.className = 'transition-jump';
									text.textContent = '[' + tr.timestamp + '] ' + tr.from + ' → ' + tr.to;
									text.addEventListener('click', ()=>{
										vscode.postMessage({ type:'jumpToTransition', payload:{ messageIndex: tr.messageIndex }});
									});
									li.appendChild(text);
									list.appendChild(li);
								});
								children.appendChild(list);
								node.appendChild(children);
								
								// Обработчик клика на toggle
								if (toggleBtn) {
									toggleBtn.addEventListener('click', ()=>{
										children.classList.toggle('collapsed');
										toggleBtn.classList.toggle('collapsed');
									});
								}
							}
							sessionsDiv.appendChild(node);
						});
						updateActiveDots();
					};
					renderSessions();
					
					function updateActiveDots(){
						// Сбрасываем активные точки
						document.querySelectorAll('.sessions .row .dot, .sessions .transition-row .dot').forEach(el=>{
							el.classList.remove('active');
						});
						if (!activeLocation) return;
						// Ставим точку на запуске
						const row = document.querySelector('.sessions .session-node[data-session-index="' + activeLocation.sessionIndex + '"] .row .dot');
						if (row) row.classList.add('active');
						// И на переходе, если есть
						if (activeLocation.transitionMessageIndex !== undefined){
							const trDot = document.querySelector('.sessions .session-node[data-session-index="' + activeLocation.sessionIndex + '"] li.transition-row[data-transition-msg="' + activeLocation.transitionMessageIndex + '"] .dot');
							if (trDot) trDot.classList.add('active');
						}
					}
					
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
		if (!this.view) {
			this.output.appendLine('  ❌ View не инициализирован!');
			return;
		}
		
		const webview = this.view.webview;
		const hasFolder = !!this.workspaceFolder;
		const hasData = !!this.combinedPath;
		const sessions = this.sessions;
		
		this.output.appendLine('  Сериализация дерева каналов...');
		const treeStart = Date.now();
		const channelsTree = this.serializeChannelsTree();
		const treeTime = Date.now() - treeStart;
		this.output.appendLine(`  ⏱ Сериализация дерева: ${treeTime}ms`);
		
		this.output.appendLine('  Подготовка данных о цветах каналов...');
		const colorsStart = Date.now();
		const channelColors = Object.fromEntries(this.channelColors.entries());
		const colorsTime = Date.now() - colorsStart;
		this.output.appendLine(`  ⏱ Подготовка цветов (${this.channelColors.size} каналов): ${colorsTime}ms`);
		
		this.output.appendLine('  Генерация HTML...');
		const renderStart = Date.now();
		webview.html = this.renderHtml({ hasFolder, hasData, sessions, channelsTree, channelColors });
		const renderTime = Date.now() - renderStart;
		this.output.appendLine(`  ⏱ Генерация HTML: ${renderTime}ms`);
		
		// Send initial counts after HTML is loaded
		if (hasData) {
			setTimeout(() => {
				const countsStart = Date.now();
				const levelCounts = this.calculateLevelCounts();
				webview.postMessage({ type: 'matchCount', payload: { count: this.parsed.length, levelCounts } });
				const countsTime = Date.now() - countsStart;
				this.output.appendLine(`  ⏱ Отправка счетчиков: ${countsTime}ms`);
			}, 100);
		}
	}

	/**
	 * Основной рендеринг HTML страницы
	 */
	private renderHtml(data: { hasFolder: boolean; hasData: boolean; sessions: AppSession[]; channelsTree: any; channelColors: any }): string {
		const nonce = String(Date.now());
		
		const stylesStart = Date.now();
		const styles = this.generateStyles();
		this.output.appendLine(`    ⏱ generateStyles: ${Date.now() - stylesStart}ms`);
		
		const sessionsStart = Date.now();
		const sessionsHtml = data.hasData ? this.generateSessionsHtml(data.sessions) : '';
		this.output.appendLine(`    ⏱ generateSessionsHtml: ${Date.now() - sessionsStart}ms`);
		
		const filtersStart = Date.now();
		const filtersHtml = data.hasData ? this.generateFiltersHtml() : '';
		this.output.appendLine(`    ⏱ generateFiltersHtml: ${Date.now() - filtersStart}ms`);
		
		const channelsStart = Date.now();
		const channelsHtml = data.hasData ? this.generateChannelsTreeHtml() : '';
		this.output.appendLine(`    ⏱ generateChannelsTreeHtml: ${Date.now() - channelsStart}ms`);
		
		const scriptStart = Date.now();
		const script = this.generateScript(data, nonce);
		this.output.appendLine(`    ⏱ generateScript: ${Date.now() - scriptStart}ms`);
		
		return `<!DOCTYPE html>
		<html lang="ru">
		<head>
			<meta charset="UTF-8" />
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this.view?.webview.cspSource}; script-src 'nonce-${nonce}';" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>Homescapes Log Viewer</title>
			<style>
${styles}
			</style>
		</head>
		<body>
			${sessionsHtml}
			${filtersHtml}
			${channelsHtml}
			${script}
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

	private async combineLogs(zipFilePath: string | null = null): Promise<void> {
		const combineStart = Date.now();
		this.output.appendLine('📂 Начало чтения файлов...');
		
		if (!this.workspaceFolder) return;
		const dir = this.workspaceFolder;
		const combinedParts: string[] = [];
		
		if (zipFilePath) {
			// Режим работы с .zip архивом
			this.output.appendLine('  Режим: ZIP архив');
			const zipStart = Date.now();
			const zip = new AdmZip(zipFilePath);
			const zipEntries = zip.getEntries();
			this.output.appendLine(`  ⏱ Открытие ZIP: ${Date.now() - zipStart}ms`);
			
			// Ищем log.txt в корне архива
			const mainLogEntry = zip.getEntry('log.txt');
			
			// Ищем вложенные log.historyХ.txt.zip
			const historyZipEntries = zipEntries.filter((entry: any) => 
				/^log\.history\d+\.txt\.zip$/.test(entry.entryName)
			);
			
			this.output.appendLine(`  Найдено вложенных архивов: ${historyZipEntries.length}`);
			
			// Сортируем history файлы от большего к меньшему
			historyZipEntries.sort((a: any, b: any) => {
				const na = Number(a.entryName.match(/history(\d+)/)?.[1] ?? 0);
				const nb = Number(b.entryName.match(/history(\d+)/)?.[1] ?? 0);
				return nb - na;
			});
			
			// Сначала добавляем вложенные history архивы
			for (const historyEntry of historyZipEntries) {
				try {
					const entryStart = Date.now();
					const historyZipData = zip.readFile(historyEntry);
					if (historyZipData) {
						const historyZip = new AdmZip(historyZipData);
						const historyLogEntry = historyZip.getEntry('log.txt');
						if (historyLogEntry) {
							const content = historyZip.readAsText(historyLogEntry, 'utf8');
							combinedParts.push(`\n===== BEGIN PART: ${historyEntry.entryName}::log.txt =====\n` + content + `\n===== END PART: ${historyEntry.entryName}::log.txt =====\n`);
							this.output.appendLine(`  ⏱ ${historyEntry.entryName}: ${Date.now() - entryStart}ms (${(content.length / 1024 / 1024).toFixed(2)} MB)`);
						}
					}
				} catch (err) {
					console.error(`Ошибка при чтении ${historyEntry.entryName}:`, err);
					this.output.appendLine(`  ❌ Ошибка при чтении ${historyEntry.entryName}`);
				}
			}
			
			// Затем добавляем основной log.txt
			if (mainLogEntry) {
				const mainStart = Date.now();
				const content = zip.readAsText(mainLogEntry, 'utf8');
				combinedParts.push(`\n===== BEGIN PART: log.txt =====\n` + content + `\n===== END PART: log.txt =====\n`);
				this.output.appendLine(`  ⏱ log.txt: ${Date.now() - mainStart}ms (${(content.length / 1024 / 1024).toFixed(2)} MB)`);
			}
		} else {
			// Режим работы с .txt файлом (старая логика)
			this.output.appendLine('  Режим: текстовый файл + архивы в папке');
			const files = fs.readdirSync(dir).filter((f: string) => f === 'log.txt' || /^log\.history\d+\.txt\.zip$/.test(f));
			// Требуемый порядок: history от большего к меньшему, затем log.txt
			const history = files.filter((f: string) => f.startsWith('log.history')).sort((a: string, b: string)=>{
				const na = Number(a.match(/history(\d+)/)?.[1] ?? 0);
				const nb = Number(b.match(/history(\d+)/)?.[1] ?? 0);
				return nb - na; // По убыванию (от большего к меньшему)
			});
			
			this.output.appendLine(`  Найдено архивов: ${history.length}`);
			
			// Сначала добавляем history файлы от большего к меньшему
			for (const z of history) {
				const entryStart = Date.now();
				const zip = new AdmZip(path.join(dir, z));
				const entry = zip.getEntry('log.txt');
				if (entry) {
					const content = zip.readAsText(entry, 'utf8');
					combinedParts.push(`\n===== BEGIN PART: ${z}::log.txt =====\n` + content + `\n===== END PART: ${z}::log.txt =====\n`);
					this.output.appendLine(`  ⏱ ${z}: ${Date.now() - entryStart}ms (${(content.length / 1024 / 1024).toFixed(2)} MB)`);
				}
			}
			
			// Затем добавляем текущий log.txt
			const currentLogPath = path.join(dir, 'log.txt');
			if (fs.existsSync(currentLogPath)) {
				const mainStart = Date.now();
				const content = fs.readFileSync(currentLogPath, 'utf8');
				combinedParts.push(`\n===== BEGIN PART: log.txt =====\n` + content + `\n===== END PART: log.txt =====\n`);
				this.output.appendLine(`  ⏱ log.txt: ${Date.now() - mainStart}ms (${(content.length / 1024 / 1024).toFixed(2)} MB)`);
			}
		}
		
		const joinStart = Date.now();
		const combined = combinedParts.join('\n');
		const joinTime = Date.now() - joinStart;
		this.output.appendLine(`  ⏱ Объединение частей: ${joinTime}ms (итого ${(combined.length / 1024 / 1024).toFixed(2)} MB)`);
		
		this.originalCombinedContent = combined; // Сохраняем оригинал
		const outDir = path.join(dir);
		const outPath = path.join(outDir, 'combined_logs.txt');
		
		const writeStart = Date.now();
		fs.writeFileSync(outPath, combined, 'utf8');
		const writeTime = Date.now() - writeStart;
		this.output.appendLine(`  ⏱ Запись файла: ${writeTime}ms`);
		
		this.combinedPath = outPath;
		
		const combineTime = Date.now() - combineStart;
		this.output.appendLine(`⏱ Общее время чтения файлов: ${combineTime}ms (${(combineTime / 1000).toFixed(2)}s)`);
		
		this.parseCombined(combined);
	}

	/**
	 * Чтение и парсинг логов
	 */
	private parseCombined(content: string): void {
		const parseStart = Date.now();
		this.output.appendLine('');
		this.output.appendLine('🔍 Начало парсинга логов...');
		
		this.parsed = [];
		this.sessions = [];
		this.tsToIndices.clear();
		this.transitionMessageIndices.clear();
		this.channelsTree.clear();
		this.channelColors.clear();
		
		const splitStart = Date.now();
		const lines = content.split(/\r?\n/);
		const splitTime = Date.now() - splitStart;
		this.output.appendLine(`  Строк в файле: ${lines.length.toLocaleString()}`);
		this.output.appendLine(`  ⏱ Разделение на строки: ${splitTime}ms`);
		const startRegex = /^================== APP STARTED =================/;
		const headPrefixRegex = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\[(.)\]/;
		let current: LogMessage | null = null;
		let index = 0;
		let sessionIndex = 0;
		let currentLineInOriginal = 0; // Счетчик строк в оригинальном файле
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (startRegex.test(line)) {
				// Ищем Build version в следующих строках до следующего APP STARTED
				let buildVersion: string | null = null;
				for (let j = i + 1; j < lines.length; j++) {
					// Если встретили следующий APP STARTED - останавливаемся
					if (startRegex.test(lines[j])) {
						break;
					}
					// Ищем строку "Build version:"
					const buildMatch = lines[j].match(/Build version:\s*(.+)/);
					if (buildMatch) {
						buildVersion = buildMatch[1].trim();
						break;
					}
				}
				
				this.sessions.push({ 
					index: ++sessionIndex, 
					startLine: currentLineInOriginal, 
					startOffset: index, 
					firstMessageTimestamp: null,
					buildVersion: buildVersion
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
				// Индексируем таймстамп для быстрого поиска по курсору
				if (!this.tsToIndices.has(timestamp)) this.tsToIndices.set(timestamp, []);
				this.tsToIndices.get(timestamp)!.push(current.index);

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
		
		const mainParseTime = Date.now() - parseStart;
		this.output.appendLine(`  ⏱ Основной парсинг: ${mainParseTime}ms`);
		this.output.appendLine(`  Сообщений распознано: ${this.parsed.length.toLocaleString()}`);
		this.output.appendLine(`  Запусков найдено: ${this.sessions.length}`);
		this.output.appendLine(`  Каналов в дереве: ${this.channelsTree.size}`);

		// После заполнения parsed и sessions — выделяем переходы состояний
		const transitionsStart = Date.now();
		const isGSM = (chs: string[]) => chs.includes('GameStateManager');
		const isChanged = (chs: string[]) => chs.includes('GameStateChanged');
		const re = /^From\s+(.+?)\s+to\s+(.+)$/;
		for (const msg of this.parsed){
			if (isGSM(msg.channels) && isChanged(msg.channels)){
				const m2 = msg.text.match(re);
				if (m2){
					const from = m2[1];
					const to = m2[2];
					const sid = this.getSessionByMessageIndex(msg.index);
					const s = this.sessions.find(s=>s.index===sid);
					if (s){
						if (!s.transitions) s.transitions = [];
						s.transitions.push({ messageIndex: msg.index, timestamp: msg.timestamp, from, to });
						this.transitionMessageIndices.add(msg.index);
					}
				}
			}
		}
		const transitionsTime = Date.now() - transitionsStart;
		this.output.appendLine(`  ⏱ Поиск переходов состояний: ${transitionsTime}ms`);
		this.output.appendLine(`  Переходов найдено: ${this.transitionMessageIndices.size}`);
		
		const parseTime = Date.now() - parseStart;
		this.output.appendLine(`⏱ Общее время парсинга: ${parseTime}ms (${(parseTime / 1000).toFixed(2)}s)`);
	}

	private async openCombined(): Promise<void> {
		if (!this.combinedPath) {
			this.output.appendLine('  ❌ Путь к combined файлу не найден');
			return;
		}
		
		// Проверяем размер файла
		const stats = fs.statSync(this.combinedPath);
		const fileSizeMB = stats.size / (1024 * 1024);
		this.output.appendLine(`  Размер combined_logs.txt: ${fileSizeMB.toFixed(2)} MB`);
		
		// Если файл очень большой (больше 50 MB), предупреждаем и пропускаем автооткрытие
		if (fileSizeMB > 50) {
			this.output.appendLine('  ⚠️ Файл слишком большой для автоматического открытия');
			this.output.appendLine('  💡 Откройте файл вручную: ' + this.combinedPath);
			vscode.window.showWarningMessage(
				`Лог файл очень большой (${fileSizeMB.toFixed(2)} MB). Откройте его вручную, если необходимо.`,
				'Открыть файл'
			).then(selection => {
				if (selection === 'Открыть файл') {
					vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath!)).then(doc => {
						vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
					});
				}
			});
			return;
		}
		
		this.output.appendLine('  Открываем текстовый документ...');
		const docStart = Date.now();
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		const docTime = Date.now() - docStart;
		this.output.appendLine(`  ⏱ openTextDocument: ${docTime}ms`);
		
		this.output.appendLine('  Показываем документ в редакторе...');
		const showStart = Date.now();
		await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
		const showTime = Date.now() - showStart;
		this.output.appendLine(`  ⏱ showTextDocument: ${showTime}ms`);
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
			// Обновим красную точку: только на запуске
			this.postActiveLocation({ sessionIndex });
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

	private async revealTransition(messageIndex: number): Promise<void> {
		if (!this.combinedPath) return;
		const msg = this.parsed.find(m => m.index === messageIndex);
		if (!msg) return;
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.combinedPath));
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		const text = doc.getText();
		const pos = text.indexOf(`[${msg.timestamp}]`);
		if (pos >= 0) {
			const start = doc.positionAt(pos);
			editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
			// Обновим красную точку: на запуске и на переходе
			const sid = this.getSessionByMessageIndex(messageIndex);
			this.postActiveLocation({ sessionIndex: sid, transitionMessageIndex: messageIndex });
		}
	}

	/**
	 * Перезагрузка документа и применение декораций
	 */
	private async reloadAndDecorate(): Promise<void> {
		if (!this.combinedPath) return;
		
		// Сбрасываем версию, так как документ будет перезагружен
		this.lastDecoratedVersion = -1;
		
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
		if (this.isApplyingDecorations) {
			this.output.appendLine('  ⏳ Декорации уже применяются, пропускаем...');
			return;
		}
		
		const editor = vscode.window.visibleTextEditors.find((e: vscode.TextEditor) => e.document.uri.fsPath === this.combinedPath);
		if (!editor) {
			this.output.appendLine('  ⚠️ Редактор с combined_logs.txt не найден, декорации не применены');
			return;
		}

		this.isApplyingDecorations = true;
		this.output.appendLine('  🎨 Применение декораций к документу...');
		const decorStart = Date.now();
		const documentVersion = editor.document.version;

		// Очистим старые декорации
		this.decorationTypes.forEach(dt => dt.dispose());
		this.decorationTypes = [];

		const text = editor.document.getText();
		const lines = text.split(/\r?\n/);
		this.output.appendLine(`  Обработка ${lines.length.toLocaleString()} строк (версия документа: ${documentVersion})...`);

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
			
			// Сохраняем версию документа, к которой применены декорации
			this.lastDecoratedVersion = documentVersion;
			
			const decorTime = Date.now() - decorStart;
			this.output.appendLine(`  ✅ Декорации применены: ${decorTime}ms (версия ${documentVersion})`);
		} else {
			this.output.appendLine('  ⚠️ Редактор больше не видим, декорации не применены');
		}
		
		// Сбрасываем флаг
		this.isApplyingDecorations = false;
	}

	// ==================== Cursor Tracking / Active Location ====================

	private postActiveLocation(payload: { sessionIndex: number; transitionMessageIndex?: number } | null): void {
		if (!this.view) return;
		this.view.webview.postMessage({ type: 'activeLocation', payload });
	}

	private handleSelectionChange(): void {
		try{
			if (!this.combinedPath) { this.postActiveLocation(null); return; }
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.uri.fsPath !== this.combinedPath) { this.postActiveLocation(null); return; }
			const pos = editor.selection.active;
			// Идем вверх по строкам, пока не найдем заголовок сообщения
			const headPrefixRegex = /^\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]\[(.)\]/;
			let lineIdx = pos.line;
			let ts: string | null = null;
			while (lineIdx >= 0){
				const lineText = editor.document.lineAt(lineIdx).text;
				const m = lineText.match(headPrefixRegex);
				if (m){ ts = m[1]; break; }
				lineIdx--;
			}
			if (!ts) { this.postActiveLocation(null); return; }
			// Мапа ts -> индексы сообщений
			const candidates = this.tsToIndices.get(ts) || [];
			if (candidates.length === 0) { this.postActiveLocation(null); return; }
			// Разрешаем неоднозначность таймстампов: считаем порядковый номер в документе до текущего заголовка
			let occurrence = 0;
			for (let i = 0; i <= lineIdx; i++){
				const t = editor.document.lineAt(i).text.match(headPrefixRegex);
				if (t && t[1] === ts) occurrence++;
			}
			const targetIndex = candidates[Math.max(0, Math.min(candidates.length - 1, occurrence - 1))];
			// Получим сессию
			const sid = this.getSessionByMessageIndex(targetIndex);
			let transitionIdx: number | undefined = undefined;
			const s = this.sessions.find(s => s.index === sid);
			if (s && Array.isArray(s.transitions) && s.transitions.length > 0){
				// Берем последний переход в этой сессии, индекс которого <= текущего сообщения
				for (let i = s.transitions.length - 1; i >= 0; i--){
					const t = s.transitions[i];
					if (t.messageIndex <= targetIndex){ transitionIdx = t.messageIndex; break; }
				}
			}
			this.postActiveLocation({ sessionIndex: sid, transitionMessageIndex: transitionIdx });
		} catch {
			this.postActiveLocation(null);
		}
	}
}


