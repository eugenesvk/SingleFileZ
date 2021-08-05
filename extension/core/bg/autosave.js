/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global infobar, URL, XMLHttpRequest, singlefile */

import * as config from "./config.js";
import * as business from "./business.js";
import * as downloads from "./downloads.js";
import * as tabsData from "./tabs-data.js";
import * as tabs from "./tabs.js";
import * as ui from "./../../ui/bg/index.js";
import { getPageData } from "./../../index.js";

const pendingMessages = {};
const replacedTabIds = {};

export {
	onMessage,
	onMessageExternal,
	onInit,
	isEnabled,
	refreshTabs,
	onTabUpdated,
	onTabRemoved,
	onTabDiscarded,
	onTabReplaced
};

async function onMessage(message, sender) {
	if (message.method.endsWith(".init")) {
		const [options, autoSaveEnabled] = await Promise.all([config.getOptions(sender.tab.url, true), isEnabled(sender.tab)]);
		return { options, autoSaveEnabled, tabId: sender.tab.id, tabIndex: sender.tab.index };
	}
	if (message.method.endsWith(".save")) {
		if (message.autoSaveDiscard || message.autoSaveRemove) {
			if (sender.tab) {
				message.tab = sender.tab;
				pendingMessages[sender.tab.id] = message;
			} else if (pendingMessages[message.tabId] && pendingMessages[message.tabId].removed && message.autoSaveRemove) {
				delete pendingMessages[message.tabId];
				await saveContent(message, { id: message.tabId, index: message.tabIndex, url: sender.url });
			}
			if (message.autoSaveUnload) {
				delete pendingMessages[message.tabId];
				await saveContent(message, sender.tab);
			}
		} else {
			delete pendingMessages[message.tabId];
			await saveContent(message, sender.tab);
		}
		return {};
	}
}

function onTabUpdated(tabId) {
	delete pendingMessages[tabId];
}

async function onTabRemoved(tabId) {
	const message = pendingMessages[tabId];
	if (message) {
		if (message.autoSaveRemove) {
			delete pendingMessages[tabId];
			await saveContent(message, message.tab);
		}
	} else {
		pendingMessages[tabId] = { removed: true };
	}
}

async function onTabDiscarded(tabId) {
	const message = pendingMessages[tabId];
	if (message) {
		delete pendingMessages[tabId];
		await saveContent(message, message.tab);
	}
}

function onTabReplaced(addedTabId, removedTabId) {
	if (pendingMessages[removedTabId] && !pendingMessages[addedTabId]) {
		pendingMessages[addedTabId] = pendingMessages[removedTabId];
		delete pendingMessages[removedTabId];
		replacedTabIds[removedTabId] = addedTabId;
	}
}

async function onMessageExternal(message, currentTab) {
	if (message.method == "enableAutoSave") {
		const allTabsData = await tabsData.get(currentTab.id);
		allTabsData[currentTab.id].autoSave = message.enabled;
		await tabsData.set(allTabsData);
		ui.refreshTab(currentTab);
	}
	if (message.method == "isAutoSaveEnabled") {
		return isEnabled(currentTab);
	}
}

async function onInit(tab) {
	const [options, autoSaveEnabled] = await Promise.all([config.getOptions(tab.url, true), isEnabled(tab)]);
	if (options && ((options.autoSaveLoad || options.autoSaveLoadOrUnload) && autoSaveEnabled)) {
		business.saveTabs([tab], { autoSave: true });
	}
}

async function isEnabled(tab) {
	if (tab) {
		const [allTabsData, rule] = await Promise.all([tabsData.get(), config.getRule(tab.url)]);
		return Boolean(allTabsData.autoSaveAll ||
			(allTabsData.autoSaveUnpinned && !tab.pinned) ||
			(allTabsData[tab.id] && allTabsData[tab.id].autoSave)) &&
			(!rule || rule.autoSaveProfile != config.DISABLED_PROFILE_NAME);
	}
}

async function refreshTabs() {
	const allTabs = (await tabs.get({}));
	return Promise.all(allTabs.map(async tab => {
		const [options, autoSaveEnabled] = await Promise.all([config.getOptions(tab.url, true), isEnabled(tab)]);
		try {
			await tabs.sendMessage(tab.id, { method: "content.init", autoSaveEnabled, options });
		} catch (error) {
			// ignored
		}
	}));
}

async function saveContent(message, tab) {
	const tabId = tab.id;
	const options = await config.getOptions(tab.url, true);
	if (options) {
		ui.onStart(tabId, 1, true);
		options.content = message.content;
		options.url = message.url;
		options.frames = message.frames;
		options.canvases = message.canvases;
		options.fonts = message.fonts;
		options.stylesheets = message.stylesheets;
		options.images = message.images;
		options.posters = message.posters;
		options.usedFonts = message.usedFonts;
		options.shadowRoots = message.shadowRoots;
		options.imports = message.imports;
		options.referrer = message.referrer;
		options.updatedResources = message.updatedResources;
		options.visitDate = new Date(message.visitDate);
		options.backgroundTab = true;
		options.autoSave = true;
		options.incognito = tab.incognito;
		options.tabId = tabId;
		options.tabIndex = tab.index;
		let pageData;
		try {
			pageData = await getPageData(options, null, null, { fetch });
			let skipped;
			if (!options.saveToGDrive) {
				const testSkip = await downloads.testSkipSave(pageData.filename, options);
				skipped = testSkip.skipped;
				options.filenameConflictAction = testSkip.filenameConflictAction;
			}
			if (!skipped) {
				if (options.includeInfobar) {
					await infobar.includeScript(pageData);
				}
				const blob = await singlefile.processors.compression.process(pageData, {
					insertTextBody: options.insertTextBody,
					url: tab.url,
					createRootDirectory: options.createRootDirectory,
					tabId,
					selfExtractingArchive: options.selfExtractingArchive,
					insertCanonicalLink: options.insertCanonicalLink,
					insertMetaNoIndex: options.insertMetaNoIndex,
					password: options.password
				});
				if (options.saveToGDrive) {
					await downloads.uploadPage(message.taskId, pageData.filename, blob, options, {});
				} else {
					pageData.url = URL.createObjectURL(blob);
					await downloads.downloadPage(pageData, options);
				}
			}
		} finally {
			if (message.taskId) {
				business.onSaveEnd(message.taskId);
			} else if (options.autoSaveDiscard && options.autoClose) {
				tabs.remove(replacedTabIds[tabId] || tabId);
				delete replacedTabIds[tabId];
			}
			if (pageData && pageData.url) {
				URL.revokeObjectURL(pageData.url);
			}
			ui.onEnd(tabId, true);
		}
	}
}

function fetch(url) {
	return new Promise((resolve, reject) => {
		const xhrRequest = new XMLHttpRequest();
		xhrRequest.withCredentials = true;
		xhrRequest.responseType = "arraybuffer";
		xhrRequest.onerror = event => reject(new Error(event.detail));
		xhrRequest.onreadystatechange = () => {
			if (xhrRequest.readyState == XMLHttpRequest.DONE) {
				resolve({
					status: xhrRequest.status,
					headers: {
						get: name => xhrRequest.getResponseHeader(name)
					},
					arrayBuffer: async () => xhrRequest.response
				});
			}
		};
		xhrRequest.open("GET", url, true);
		xhrRequest.send();
	});
}