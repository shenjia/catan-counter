(function () {
  'use strict';

  // ======================== Constants ========================

  const RESOURCES = ['lumber', 'brick', 'wool', 'grain', 'ore'];

  const BUILD_COSTS = {
    road:       { lumber: 1, brick: 1 },
    settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
    city:       { grain: 2, ore: 3 },
    devCard:    { wool: 1, grain: 1, ore: 1 },
  };

  const CARD_BACK_URL = 'https://cdn.colonist.io/dist/assets/card_rescardback.03c18312a76028b0d9c9.svg';

  // ======================== State ========================

  const state = {
    myUsername: null,
    players: new Map(),       // name → { resources: {...}, devCards: 0, unknownResources: 0 }
    playerOrder: [],          // display order (all players including me)
    messageCache: new Map(),
    panel: null,
    observer: null,
    imageUrls: {},
  };

  function createPlayerState() {
    const resources = {};
    for (const r of RESOURCES) resources[r] = 0;
    return { resources, devCards: 0, unknownResources: 0, avatar: '', vp: 0, army: 0, road: 0, color: '', active: false };
  }

  function addPlayer(name) {
    if (!name || state.players.has(name)) return;
    state.players.set(name, createPlayerState());
    state.playerOrder.push(name);
  }

  function isTracked(name) {
    return name && name !== state.myUsername && state.players.has(name);
  }

  // ======================== Resource Helpers ========================

  function addRes(playerName, res, count) {
    if (count === undefined) count = 1;
    const p = state.players.get(playerName);
    if (!p) return;
    p.resources[res] += count;
  }

  function removeRes(playerName, res, count) {
    if (count === undefined) count = 1;
    const p = state.players.get(playerName);
    if (!p) return;
    p.resources[res] = Math.max(0, p.resources[res] - count);
  }

  function addUnknown(playerName, count) {
    if (count === undefined) count = 1;
    const p = state.players.get(playerName);
    if (!p) return;
    p.unknownResources += count;
  }

  function spendResources(playerName, cost) {
    const p = state.players.get(playerName);
    if (!p) return;
    let shortfall = 0;
    for (const [res, needed] of Object.entries(cost)) {
      const have = p.resources[res];
      if (have >= needed) {
        p.resources[res] -= needed;
      } else {
        p.resources[res] = 0;
        shortfall += (needed - have);
      }
    }
    p.unknownResources = Math.max(0, p.unknownResources - shortfall);
  }

  // If victim has only one known resource type (no unknowns), deduce what was stolen
  function resolveStolenResource(victimName) {
    const victim = state.players.get(victimName);
    if (!victim) return null;
    const knownTypes = RESOURCES.filter(r => victim.resources[r] > 0);
    if (knownTypes.length === 1 && victim.unknownResources === 0) return knownTypes[0];
    return null;
  }

  // Unknown steal: convert uncertain resources to unknowns
  // e.g. {wood:1, brick:1, sheep:1} + 1 stolen → {wood:0, brick:0, sheep:0, unknown:2}
  // e.g. {wood:2, sheep:1}          + 1 stolen → {wood:1, sheep:0, unknown:1}
  function applyUnknownSteal(victimName, stolenCount) {
    const p = state.players.get(victimName);
    if (!p) return;
    const totalBefore = RESOURCES.reduce((sum, r) => sum + p.resources[r], 0) + p.unknownResources;
    const totalAfter = Math.max(0, totalBefore - stolenCount);
    let sumGuaranteed = 0;
    for (const r of RESOURCES) {
      const guaranteed = Math.max(0, p.resources[r] - stolenCount);
      p.resources[r] = guaranteed;
      sumGuaranteed += guaranteed;
    }
    p.unknownResources = Math.max(0, totalAfter - sumGuaranteed);
  }

  // Trade offer: player offers specific resources → resolve unknowns
  // e.g. 3 unknown + offers Brick+Wool → 1 Brick, 1 Wool, 1 unknown
  function resolveTradeOffer(playerName, offeredResources) {
    const p = state.players.get(playerName);
    if (!p || p.unknownResources <= 0) return;

    const needed = {};
    for (const r of offeredResources) needed[r] = (needed[r] || 0) + 1;

    for (const [res, count] of Object.entries(needed)) {
      const shortfall = Math.max(0, count - p.resources[res]);
      const canConvert = Math.min(shortfall, p.unknownResources);
      p.resources[res] += canConvert;
      p.unknownResources -= canConvert;
    }
  }

  // Discard unknown: remove one card at a time (most abundant known first, then unknown)
  function discardOneCard(playerName) {
    const p = state.players.get(playerName);
    if (!p) return;
    let best = null, bestCount = 0;
    for (const r of RESOURCES) {
      if (p.resources[r] > bestCount) { best = r; bestCount = p.resources[r]; }
    }
    if (best) {
      p.resources[best]--;
    } else if (p.unknownResources > 0) {
      p.unknownResources--;
    }
  }

  // ======================== Reset ========================

  function resetTracking() {
    // Clear all player state
    for (const [, p] of state.players) {
      for (const r of RESOURCES) p.resources[r] = 0;
      p.devCards = 0;
      p.unknownResources = 0;
    }
    // Clear message cache and reprocess from feed
    state.messageCache.clear();
    const feedContainer = document.querySelector('[class*="gameFeedsContainer"]');
    if (feedContainer) {
      const scroller = feedContainer.querySelector('[class*="virtualScroller"]');
      if (scroller) processFeedItems(scroller);
    }
    updatePanel();
    console.log('[CatanCounter] Reset complete — reprocessing from scratch');
  }

  // ======================== HTML Parsing ========================

  function extractResourcesFromHTML(html) {
    const found = [];
    for (const res of RESOURCES) {
      const regex = new RegExp('card_' + res, 'g');
      while (regex.exec(html)) found.push(res);
    }
    return found;
  }

  function getPlayerName(feedEl) {
    const spans = feedEl.querySelectorAll('span');
    for (const s of spans) {
      const style = s.getAttribute('style') || '';
      if (style.includes('font-weight:600') || style.includes('font-weight: 600')) {
        return s.textContent.trim();
      }
    }
    return null;
  }

  function splitHTMLAt(html, keyword) {
    const idx = html.indexOf(keyword);
    if (idx === -1) return null;
    return { before: html.substring(0, idx), after: html.substring(idx + keyword.length) };
  }

  // ======================== Message Parsing ========================

  function parseMessage(playerName, text, html) {
    if (!playerName) return;
    if (playerName === 'You' || playerName === 'you') playerName = state.myUsername;
    if (!state.players.has(playerName)) return;

    const lower = text.toLowerCase();

    // --- Ignore non-resource messages early ---
    if (lower.includes('rolled')) return;
    if (lower.includes('placed a settlement') || lower.includes('placed a road')) return;
    if (lower.includes('placed a city')) return;
    if (lower.includes('game started')) return;

    const resources = extractResourcesFromHTML(html);

    if (resources.length === 0) {
      for (const res of RESOURCES) {
        if (lower.includes(res)) resources.push(res);
      }
    }

    console.log('[CatanCounter]', playerName, '|', text.substring(0, 80), '| res:', resources.join(','));

    // --- Trade offer / counter offer — resolve unknowns from offered resources ---
    if (lower.includes('wants to give') || lower.includes('wants to trade') ||
        lower.includes('proposed counter offer') || lower.includes('offering')) {
      if (isTracked(playerName)) {
        // Try to split HTML at " for " to get offered resources (before "for")
        const parts = splitHTMLAt(html, ' for ');
        let offered = [];
        if (parts) {
          offered = extractResourcesFromHTML(parts.before);
        }
        // Fallback: if split failed, all resources in the message are offered
        if (offered.length === 0 && resources.length > 0) {
          offered = resources;
        }
        if (offered.length > 0) {
          console.log('[CatanCounter] → trade offer:', playerName, 'offers', offered.join(','));
          resolveTradeOffer(playerName, offered);
        }
      }
      return;
    }

    // --- Building ---
    if (lower.includes('road') && (lower.includes('built') || lower.includes('constructed') || lower.includes('paved'))) {
      if (isTracked(playerName)) { console.log('[CatanCounter] → built road:', playerName); spendResources(playerName, BUILD_COSTS.road); }
      return;
    }
    if (lower.includes('settlement') && lower.includes('built')) {
      if (isTracked(playerName)) { console.log('[CatanCounter] → built settlement:', playerName); spendResources(playerName, BUILD_COSTS.settlement); }
      return;
    }
    if ((lower.includes('city') && (lower.includes('built') || lower.includes('upgraded'))) ||
        lower.includes('upgraded to a city') || lower.includes('upgraded to city')) {
      if (isTracked(playerName)) { console.log('[CatanCounter] → built city:', playerName); spendResources(playerName, BUILD_COSTS.city); }
      return;
    }
    if ((lower.includes('bought') || lower.includes('purchased')) &&
        (lower.includes('development card') || lower.includes('dev card') || html.includes('card_devcardback'))) {
      if (isTracked(playerName)) {
        console.log('[CatanCounter] → bought dev card:', playerName);
        spendResources(playerName, BUILD_COSTS.devCard);
        state.players.get(playerName).devCards++;
      }
      return;
    }

    // --- Used dev card ---
    if (lower.includes('used') && (lower.includes('knight') || lower.includes('year of plenty') ||
        lower.includes('monopoly') || lower.includes('road building') || html.includes('card_devcardback'))) {
      if (isTracked(playerName)) {
        const p = state.players.get(playerName);
        if (p.devCards > 0) { console.log('[CatanCounter] → used dev card:', playerName); p.devCards--; }
      }
    }

    // --- Bank / Port trade ---
    if (lower.includes('traded with bank') || lower.includes('traded with the bank') ||
        lower.includes('traded at port') || lower.includes('traded at a port') ||
        lower.includes('gave bank') || lower.includes('gave the bank')) {
      if (isTracked(playerName)) parseBankTrade(playerName, html);
      return;
    }

    // --- Player-to-player trade ("gave X and got Y from Z") ---
    if (lower.includes(' gave ') && lower.includes(' got ') && lower.includes(' from ')) {
      parsePlayerTrade(playerName, text, html);
      return;
    }

    // --- Player-to-player trade (legacy "traded with") ---
    if (lower.includes('traded with')) {
      parsePlayerTrade(playerName, text, html);
      return;
    }

    // --- Discard ---
    if (lower.includes('discard')) {
      if (isTracked(playerName)) {
        if (resources.length > 0) {
          resources.forEach(r => removeRes(playerName, r));
        } else {
          const countMatch = lower.match(/discard\s+(?:ed\s+)?(\d+)/);
          const count = countMatch ? parseInt(countMatch[1]) : 1;
          for (let i = 0; i < count; i++) discardOneCard(playerName);
        }
      }
      return;
    }

    // --- Steal with "from" ---
    if (lower.includes('stole') && lower.includes('from')) {
      handleSteal(playerName, text, resources, lower);
      return;
    }

    // --- Monopoly result (no "from") ---
    if (lower.includes('stole') && !lower.includes('from')) {
      if (resources.length > 0) {
        const countMatch = lower.match(/stole\s+(\d+)/);
        const count = countMatch ? parseInt(countMatch[1]) : 1;
        if (isTracked(playerName)) {
          console.log('[CatanCounter] → monopoly result:', playerName, count, resources.join(','));
          resources.forEach(r => addRes(playerName, r, count));
        }
        // Remove that resource from all other tracked players
        for (const [otherName, otherP] of state.players) {
          if (otherName !== playerName && isTracked(otherName)) {
            resources.forEach(r => { otherP.resources[r] = 0; });
          }
        }
      }
      return;
    }

    // --- Year of Plenty ---
    if (lower.includes('year of plenty')) {
      if (isTracked(playerName)) resources.forEach(r => addRes(playerName, r));
      return;
    }

    // --- Monopoly ---
    if (lower.includes('monopoly')) {
      handleMonopoly(playerName, text, resources);
      return;
    }

    // --- Resource collection ---
    if (resources.length > 0) {
      const collectKeywords = ['got', 'received', 'collected', 'gained', 'took'];
      if (collectKeywords.some(kw => lower.includes(kw))) {
        if (isTracked(playerName)) {
          console.log('[CatanCounter] → collected:', playerName, resources.join(','));
          resources.forEach(r => addRes(playerName, r));
        }
      } else {
        console.log('[CatanCounter] unmatched resources:', text.substring(0, 100));
      }
      return;
    }

    // Unmatched non-resource message — log at debug level only
    console.log('[CatanCounter] skip:', text.substring(0, 80));
  }

  function handleSteal(playerName, text, resources, lower) {
    // Parse stealer from text before "stole" — playerName may be the victim!
    const stoleIdx = lower.indexOf('stole');
    const beforeStole = text.substring(0, stoleIdx).trim();

    let stealerName = null;
    if (beforeStole.toLowerCase() === 'you') {
      stealerName = state.myUsername;
    } else {
      for (const name of state.playerOrder) {
        if (name && beforeStole.toLowerCase() === name.toLowerCase()) {
          stealerName = name;
          break;
        }
      }
    }

    // Parse victim from text after "from"
    const fromIdx = lower.lastIndexOf('from');
    const afterFrom = text.substring(fromIdx + 4).trim();

    let victimName = null;
    if (afterFrom.toLowerCase().startsWith('you')) {
      victimName = state.myUsername;
    } else {
      for (const name of state.playerOrder) {
        if (name && afterFrom.toLowerCase().startsWith(name.toLowerCase())) {
          victimName = name;
          break;
        }
      }
    }

    console.log('[CatanCounter] → steal parsed: stealer=', stealerName, '| victim=', victimName, '| res=', resources.join(','));

    if (resources.length > 0) {
      // Known resource type (shown in HTML)
      if (isTracked(stealerName)) resources.forEach(r => addRes(stealerName, r));
      if (isTracked(victimName)) resources.forEach(r => removeRes(victimName, r));
    } else {
      // Unknown resource — try single-type deduction first
      let deduced = null;
      if (victimName && isTracked(victimName)) {
        deduced = resolveStolenResource(victimName);
      }

      if (deduced) {
        console.log('[CatanCounter] → deduced steal:', deduced, 'from', victimName);
        if (isTracked(stealerName)) addUnknown(stealerName, 1);
        removeRes(victimName, deduced);
      } else {
        console.log('[CatanCounter] → unknown steal:', stealerName, 'from', victimName || '?');
        if (victimName && isTracked(victimName)) applyUnknownSteal(victimName, 1);
        if (isTracked(stealerName)) addUnknown(stealerName, 1);
      }
    }
  }

  function parseBankTrade(playerName, html) {
    let parts = splitHTMLAt(html, ' and took ');
    if (!parts) parts = splitHTMLAt(html, ' for ');
    if (!parts) return;
    const gave = extractResourcesFromHTML(parts.before);
    const got = extractResourcesFromHTML(parts.after);
    gave.forEach(r => removeRes(playerName, r));
    got.forEach(r => addRes(playerName, r));
  }

  function parsePlayerTrade(playerName, text, html) {
    // Find the other player in the trade
    let otherPlayer = null;
    for (const name of state.playerOrder) {
      if (name && name !== playerName && text.includes(name)) {
        otherPlayer = name;
        break;
      }
    }
    if (!otherPlayer) {
      if (text.toLowerCase().includes('from you') || text.toLowerCase().includes('traded with you')) {
        otherPlayer = state.myUsername;
      }
    }

    // Format: "gave Brick Wool and got Grain from deepthink"
    let gave = [];
    let got = [];

    const gaveIdx = html.indexOf(' gave ');
    const gotIdx = html.indexOf(' and got ');
    const fromIdx = html.indexOf(' from ');

    if (gaveIdx !== -1 && gotIdx !== -1) {
      // "gave X and got Y from Z" format
      gave = extractResourcesFromHTML(html.substring(gaveIdx, gotIdx));
      const gotEnd = fromIdx !== -1 ? fromIdx : html.length;
      got = extractResourcesFromHTML(html.substring(gotIdx, gotEnd));
    } else {
      // Legacy "traded with X for Y" format
      const parts = splitHTMLAt(html, ' for ');
      if (!parts) return;
      gave = extractResourcesFromHTML(parts.before);
      got = extractResourcesFromHTML(parts.after);
    }

    console.log('[CatanCounter] → trade:', playerName, 'gave', gave.join(','), 'got', got.join(','), '| other:', otherPlayer || '?');

    // playerName gave X, got Y; otherPlayer gave Y, got X
    if (isTracked(playerName)) {
      gave.forEach(r => removeRes(playerName, r));
      got.forEach(r => addRes(playerName, r));
    }
    if (otherPlayer && isTracked(otherPlayer)) {
      gave.forEach(r => addRes(otherPlayer, r));
      got.forEach(r => removeRes(otherPlayer, r));
    }
  }

  function handleMonopoly(playerName, text, resources) {
    const lower = text.toLowerCase();
    let target = null;
    for (const res of RESOURCES) {
      if (lower.includes(res)) { target = res; break; }
    }
    if (!target && resources.length > 0) target = resources[0];
    if (!target) return;

    // Remove that resource from all OTHER tracked players
    for (const [name, p] of state.players) {
      if (name !== playerName && isTracked(name)) {
        p.resources[target] = 0;
      }
    }
    if (isTracked(playerName) && resources.length > 0) {
      resources.forEach(r => addRes(playerName, r));
    }
  }

  // ======================== Player Info Scanner ========================

  const PLAYER_COLORS = { '1': '#CF4449', '2': '#285FBD', '3': '#E8983E', '4': '#4CAF50', '5': '#3D3D3D', '6': '#9C27B0' };

  // Radial gradient glows matching colonist.io avatar style
  const PLAYER_GLOWS = {
    '1': 'radial-gradient(circle at 50% 50%, #f47474 0%, #e85555 17%, #d44444 40%, #b33333 65%, #8a1e1e 86%, #fff 89% 92%, #5a0e0e 96%)',
    '2': 'radial-gradient(circle at 50% 50%, #52b1cc 0%, #4fabcb 17%, #469bc8 40%, #3680c4 65%, #215bbe 86%, #fff 89% 92%, #0e2b87 96%)',
    '3': 'radial-gradient(circle at 50% 50%, #f5b76c 0%, #f0a44e 17%, #e8903a 40%, #d47a26 65%, #b56015 86%, #fff 89% 92%, #7a3e08 96%)',
    '4': 'radial-gradient(circle at 50% 50%, #7bd67e 0%, #66cc6a 17%, #52b856 40%, #3d9e42 65%, #2a8230 86%, #fff 89% 92%, #165a18 96%)',
    '5': 'radial-gradient(circle at 50% 50%, #6e6e6e 0%, #5c5c5c 17%, #4a4a4a 40%, #383838 65%, #262626 86%, #fff 89% 92%, #111 96%)',
    '6': 'radial-gradient(circle at 50% 50%, #c17dd4 0%, #b06ac6 17%, #9a56b5 40%, #7e42a0 65%, #622f88 86%, #fff 89% 92%, #3a1760 96%)',
  };

  function scanPlayerInfo() {
    // Opponents
    const oppRows = document.querySelectorAll('[class*="opponentPlayerRow"]');
    for (const row of oppRows) {
      const nameEl = row.querySelector('[class*="username"]');
      if (!nameEl) continue;
      const name = nameEl.textContent.trim();
      const p = state.players.get(name);
      if (!p) continue;

      const avatarImg = row.querySelector('[class*="avatarImage"]');
      if (avatarImg) p.avatar = avatarImg.src;

      const colorAttr = row.getAttribute('data-player-color');
      if (colorAttr) p.color = colorAttr;

      const vpEl = row.querySelector('[class*="victoryPoints"]');
      if (vpEl) p.vp = parseInt(vpEl.textContent) || 0;

      const achievements = row.querySelectorAll('[class*="achievementCount"]');
      if (achievements[0]) p.army = parseInt(achievements[0].textContent) || 0;
      if (achievements[1]) p.road = parseInt(achievements[1].textContent) || 0;

      // Detect active player (has "active" class on information wrapper)
      const infoWrapper = row.querySelector('[class*="informationWrapper"]');
      p.active = infoWrapper ? infoWrapper.className.includes('active') : false;

      // Correct resource/dev card counts from DOM
      correctCardCounts(row, name, p);
    }

    // Current user
    const curEl = document.querySelector('[class*="currentUser"]');
    if (curEl) {
      const p = state.players.get(state.myUsername);
      if (p) {
        const avatarImg = curEl.querySelector('[class*="avatarImage"]');
        if (avatarImg) p.avatar = avatarImg.src;

        const playerRow = curEl.closest('[data-player-color]');
        if (playerRow) p.color = playerRow.getAttribute('data-player-color');

        const vpEl = curEl.querySelector('[class*="victoryPoints"]');
        if (vpEl) p.vp = parseInt(vpEl.textContent) || 0;

        const achievements = curEl.querySelectorAll('[class*="achievementCount"]');
        if (achievements[0]) p.army = parseInt(achievements[0].textContent) || 0;
        if (achievements[1]) p.road = parseInt(achievements[1].textContent) || 0;
      }
    }
  }

  // Compare tracked totals with DOM card counts and correct discrepancies
  function correctCardCounts(rowEl, name, p) {
    const resCardEl = rowEl.querySelector('[data-resource-card] [class*="count"]');
    const devCardEl = rowEl.querySelector('[data-development-card] [class*="count"]');

    if (!resCardEl && !devCardEl) return;

    const domRes = resCardEl ? (parseInt(resCardEl.textContent) || 0) : -1;
    const domDev = devCardEl ? (parseInt(devCardEl.textContent) || 0) : -1;

    const trackedRes = RESOURCES.reduce((sum, r) => sum + p.resources[r], 0) + p.unknownResources;
    const trackedDev = p.devCards;

    // Correct resource count
    if (domRes >= 0 && domRes !== trackedRes) {
      const diff = domRes - trackedRes;
      if (diff > 0) {
        // We undercounted — add unknowns
        p.unknownResources += diff;
      } else {
        // We overcounted — remove from unknowns first, then known
        let toRemove = -diff;
        while (toRemove > 0 && p.unknownResources > 0) { p.unknownResources--; toRemove--; }
        while (toRemove > 0) {
          let best = null, bestCount = 0;
          for (const r of RESOURCES) {
            if (p.resources[r] > bestCount) { best = r; bestCount = p.resources[r]; }
          }
          if (!best) break;
          p.resources[best]--;
          toRemove--;
        }
      }
      console.log('[CatanCounter] corrected resources for', name, ':', trackedRes, '→', domRes);
    }

    // Correct dev card count
    if (domDev >= 0 && domDev !== trackedDev) {
      p.devCards = domDev;
      console.log('[CatanCounter] corrected devCards for', name, ':', trackedDev, '→', domDev);
    }
  }

  // ======================== UI Panel ========================

  function createPanel() {
    if (state.panel) return;

    const host = document.createElement('div');
    host.id = 'catan-counter-root';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }

      .panel {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 99999;
        background: rgba(245, 230, 200, 0.95);
        border: 2px solid #C9A96E;
        border-radius: 8px;
        padding: 8px 10px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        width: 780px; /* default, overridden by positionPanel */
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        user-select: none;
        cursor: grab;
      }


      .player-section {
        padding: 6px 4px;
        border-radius: 6px;
        transition: background 0.3s;
      }

      .player-section.active {
        background: rgba(255, 255, 255, 0.6);
      }

      .player-section + .player-section {
        border-top: 1px solid rgba(201, 169, 110, 0.4);
      }
      .player-section:last-of-type { border-bottom: none; }

      .player-top-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }

      .player-name {
        font-size: 13px;
        font-weight: 600;
        color: #4A3728;
      }

      .player-achievements {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .achievement {
        display: flex;
        align-items: center;
        gap: 2px;
        font-size: 12px;
        font-weight: 600;
        color: #7A6248;
      }

      .achievement img {
        width: 16px;
        height: 16px;
      }

      .achievement.gold {
        color: #B8860B;
      }

      .player-body {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }

      .player-left {
        display: flex;
        flex-direction: column;
        align-items: center;
        flex-shrink: 0;
      }

      .player-avatar {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 1.5px solid #fff;
        object-fit: cover;
      }

      .player-vp-wrap {
        position: relative;
        margin-top: -10px;
        text-align: center;
      }

      .vp-ribbon {
        width: 38px;
        height: 20px;
        display: block;
      }

      .vp-number {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 700;
        color: #333;
      }

      .player-right {
        flex: 1;
        min-width: 0;
      }

      .cards-row {
        display: flex;
        gap: 4px;
        align-items: flex-end;
        flex-wrap: wrap;
      }

      .card-wrap {
        position: relative;
        width: 36px;
        height: 50px;
      }

      .card-wrap img {
        width: 36px;
        height: 50px;
        display: block;
        border-radius: 4px;
      }

      .card-wrap.unknown img {
        opacity: 0.85;
      }

      .badge {
        position: absolute;
        top: -4px;
        right: -6px;
        background: #285FBD;
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        min-width: 18px;
        height: 18px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 3px;
      }

      .badge.unknown-badge {
        background: #8B7355;
      }

      .dev-card {
        position: relative;
        width: 30px;
        height: 42px;
      }

      .dev-card img {
        width: 30px;
        height: 42px;
        display: block;
        border-radius: 3px;
      }

      .bottom-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 4px;
        padding-top: 3px;
        border-top: 1px solid rgba(201, 169, 110, 0.4);
      }

      .log-stats {
        font-size: 11px;
        color: #aaa;
      }
      .log-stats.incomplete {
        color: #d44;
      }

      .empty {
        font-size: 12px;
        color: #999;
        text-align: center;
        padding: 4px 0;
      }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';

    shadow.appendChild(style);
    shadow.appendChild(panel);
    document.body.appendChild(host);

    state.panel = { host, shadow, panel, visible: true, dragState: null };

    // --- Drag (entire panel) ---
    panel.addEventListener('mousedown', (e) => {
      if (e.target.closest('.reset-btn')) return;
      const rect = panel.getBoundingClientRect();
      state.panel.dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
      panel.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!state.panel || !state.panel.dragState) return;
      const d = state.panel.dragState;
      panel.style.left = (d.origLeft + e.clientX - d.startX) + 'px';
      panel.style.top = (d.origTop + e.clientY - d.startY) + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!state.panel || !state.panel.dragState) return;
      panel.style.cursor = '';
      state.panel.dragState = null;
      state.panel.dragged = true;
      const rect = panel.getBoundingClientRect();
      localStorage.setItem('catan-counter-pos', JSON.stringify({ left: rect.left, top: rect.top }));
    });

    // Toggle with backtick
    document.addEventListener('keydown', (e) => {
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        state.panel.visible = !state.panel.visible;
        state.panel.host.style.display = state.panel.visible ? '' : 'none';
      }
    });

    positionPanel();
    const reposition = () => { state.panel.dragged = false; positionPanel(); };
    window.addEventListener('resize', reposition);
    const ro = new ResizeObserver(reposition);
    ro.observe(document.body);

    // Also watch the player info container for size changes
    const watchContainer = () => {
      const pc = document.querySelector('[data-player-information-container]');
      if (pc) ro.observe(pc);
    };
    watchContainer();
    // Retry in case container appears later
    setTimeout(watchContainer, 3000);

    // Periodically scan player info changes (VP, road, army, active)
    setInterval(() => {
      if (state.panel && state.panel.visible) updatePanel();
    }, 1000);
  }

  function positionPanel() {
    if (!state.panel) return;
    if (state.panel.dragged) return;
    const panelEl = state.panel.panel;

    const playerContainer = document.querySelector('[data-player-information-container]');
    if (!playerContainer) return;
    const rect = playerContainer.getBoundingClientRect();
    panelEl.style.left = rect.left + 'px';
    panelEl.style.top = rect.top + 'px';
    panelEl.style.width = rect.width + 'px';
    panelEl.style.right = 'auto';
  }

  function updatePanel() {
    if (!state.panel) return;
    const panel = state.panel.panel;
    panel.innerHTML = '';

    // Scan DOM for latest player info (VP, army, road, avatar)
    scanPlayerInfo();

    const ARMY_ICON = 'https://cdn.colonist.io/dist/assets/icon_largest_army.206b49b3c9d2b206f699.svg';
    const ARMY_ICON_GOLD = 'https://cdn.colonist.io/dist/assets/icon_largest_army_highlight.be615b163db0dbd64fbc.svg';
    const ROAD_ICON = 'https://cdn.colonist.io/dist/assets/icon_longest_road.5cfdeb3352b20463e64b.svg';
    const ROAD_ICON_GOLD = 'https://cdn.colonist.io/dist/assets/icon_longest_road_highlight.50dc66b851ecee9a8662.svg';
    const RIBBON = 'https://cdn.colonist.io/dist/assets/ribbon_small.f1f6f5885b2535205fe3.svg';

    // Player sections (opponents only)
    let hasAnyPlayer = false;
    for (const name of state.playerOrder) {
      if (!isTracked(name)) continue;
      const p = state.players.get(name);
      if (!p) continue;

      hasAnyPlayer = true;
      const section = document.createElement('div');
      section.className = 'player-section' + (p.active ? ' active' : '');

      // Row 1: name + achievements
      const topRow = document.createElement('div');
      topRow.className = 'player-top-row';

      const nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      nameEl.textContent = name;
      topRow.appendChild(nameEl);

      const achievements = document.createElement('div');
      achievements.className = 'player-achievements';

      const armyIcon = p.army >= 3 ? ARMY_ICON_GOLD : ARMY_ICON;
      const armyStat = document.createElement('span');
      armyStat.className = 'achievement' + (p.army >= 3 ? ' gold' : '');
      armyStat.innerHTML = '<img src="' + armyIcon + '">';
      armyStat.appendChild(document.createTextNode(p.army));
      achievements.appendChild(armyStat);

      const roadIcon = p.road >= 5 ? ROAD_ICON_GOLD : ROAD_ICON;
      const roadStat = document.createElement('span');
      roadStat.className = 'achievement' + (p.road >= 5 ? ' gold' : '');
      roadStat.innerHTML = '<img src="' + roadIcon + '">';
      roadStat.appendChild(document.createTextNode(p.road));
      achievements.appendChild(roadStat);

      topRow.appendChild(achievements);
      section.appendChild(topRow);

      // Row 2: avatar+VP on left, cards on right
      const body = document.createElement('div');
      body.className = 'player-body';

      // Left: avatar + VP ribbon
      const leftCol = document.createElement('div');
      leftCol.className = 'player-left';

      if (p.avatar) {
        const avatar = document.createElement('img');
        avatar.className = 'player-avatar';
        avatar.src = p.avatar;
        avatar.draggable = false;
        const glow = PLAYER_GLOWS[p.color];
        if (glow) avatar.style.background = glow;
        leftCol.appendChild(avatar);
      }

      const vpWrap = document.createElement('div');
      vpWrap.className = 'player-vp-wrap';
      const ribbonImg = document.createElement('img');
      ribbonImg.className = 'vp-ribbon';
      ribbonImg.src = RIBBON;
      ribbonImg.draggable = false;
      vpWrap.appendChild(ribbonImg);
      const vpNum = document.createElement('span');
      vpNum.className = 'vp-number';
      vpNum.textContent = p.vp;
      vpWrap.appendChild(vpNum);
      leftCol.appendChild(vpWrap);

      body.appendChild(leftCol);

      // Right: cards
      const rightCol = document.createElement('div');
      rightCol.className = 'player-right';

      const cardsRow = document.createElement('div');
      cardsRow.className = 'cards-row';

      const totalKnown = RESOURCES.reduce((sum, r) => sum + p.resources[r], 0);
      const total = totalKnown + p.unknownResources;

      for (const res of RESOURCES) {
        const count = p.resources[res];
        if (count <= 0) continue;
        const wrap = document.createElement('div');
        wrap.className = 'card-wrap';
        const img = document.createElement('img');
        img.src = state.imageUrls[res];
        img.draggable = false;
        wrap.appendChild(img);
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = count;
        wrap.appendChild(badge);
        cardsRow.appendChild(wrap);
      }

      if (p.unknownResources > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'card-wrap unknown';
        const img = document.createElement('img');
        img.src = CARD_BACK_URL;
        img.draggable = false;
        wrap.appendChild(img);
        const badge = document.createElement('div');
        badge.className = 'badge unknown-badge';
        badge.textContent = p.unknownResources;
        wrap.appendChild(badge);
        cardsRow.appendChild(wrap);
      }

      if (p.devCards > 0) {
        const devWrap = document.createElement('div');
        devWrap.className = 'dev-card';
        const devImg = document.createElement('img');
        devImg.src = state.imageUrls.devCard;
        devImg.draggable = false;
        devWrap.appendChild(devImg);
        const devBadge = document.createElement('div');
        devBadge.className = 'badge';
        devBadge.textContent = p.devCards;
        devWrap.appendChild(devBadge);
        cardsRow.appendChild(devWrap);
      }

      if (total === 0 && p.devCards === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No resources';
        cardsRow.appendChild(empty);
      }

      rightCol.appendChild(cardsRow);
      body.appendChild(rightCol);
      section.appendChild(body);
      panel.appendChild(section);
    }

    if (!hasAnyPlayer) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Waiting for players...';
      panel.appendChild(empty);
    }
  }

  // ======================== Image URL Detection ========================

  function detectImageUrls() {
    const allImgs = document.querySelectorAll('img');
    for (const img of allImgs) {
      const src = img.getAttribute('src') || '';
      for (const res of RESOURCES) {
        if (src.includes('card_' + res)) state.imageUrls[res] = src;
      }
      if (src.includes('card_devcardback')) state.imageUrls.devCard = src;
    }
    const fb = {
      lumber: 'card_lumber.cf22f8083cf89c2a29e7.svg',
      brick:  'card_brick.5950ea07a7ea01bc54a5.svg',
      wool:   'card_wool.17a6dea8d559949f0ccc.svg',
      grain:  'card_grain.09c9d82146a64bce69b5.svg',
      ore:    'card_ore.117f64dab28e1c987958.svg',
      devCard: 'card_devcardback.92569a1abd04a8c1c17e.svg',
    };
    for (const [k, file] of Object.entries(fb)) {
      if (!state.imageUrls[k]) state.imageUrls[k] = 'https://cdn.colonist.io/dist/assets/' + file;
    }
  }

  // ======================== Player Detection ========================

  function detectPlayers() {
    // Current user
    const curEl = document.querySelector('[class*="currentUser"]');
    if (curEl) {
      const nameEl = curEl.querySelector('[class*="usernameLarge"]') || curEl.querySelector('[class*="username"]');
      if (nameEl) state.myUsername = nameEl.textContent.trim();
    }

    // All opponents
    const oppRows = document.querySelectorAll('[class*="opponentPlayerRow"]');
    for (const row of oppRows) {
      const nameEl = row.querySelector('[class*="username"]');
      if (nameEl) addPlayer(nameEl.textContent.trim());
    }

    // Also add current user to the map (for tracking purposes, but not displayed)
    if (state.myUsername) addPlayer(state.myUsername);
  }

  // ======================== Feed Observer ========================

  function isOpaque(feedEl) {
    const style = feedEl.getAttribute('style') || '';
    const match = style.match(/opacity\s*:\s*([\d.]+)/);
    if (!match) return true;
    return parseFloat(match[1]) >= 0.9;
  }

  function recomputeFromCache() {
    for (const [, p] of state.players) {
      for (const r of RESOURCES) p.resources[r] = 0;
      p.devCards = 0;
      p.unknownResources = 0;
    }
    const sorted = [...state.messageCache.keys()].sort((a, b) => parseInt(a) - parseInt(b));
    for (const idx of sorted) {
      const data = state.messageCache.get(idx);
      if (data) parseMessage(data.playerName, data.text, data.html);
    }
  }

  function processFeedItems(scroller) {
    const items = Array.from(scroller.querySelectorAll('[data-index]'));
    items.sort((a, b) => parseInt(a.getAttribute('data-index')) - parseInt(b.getAttribute('data-index')));

    let cutoff = -1;
    for (const item of items) {
      const feedEl = item.querySelector('[class*="feedMessage"]');
      if (feedEl && isOpaque(feedEl)) {
        const idx = parseInt(item.getAttribute('data-index'));
        if (idx > cutoff) cutoff = idx;
      }
    }

    if (cutoff >= 0) {
      let trimmed = false;
      for (const key of [...state.messageCache.keys()]) {
        if (parseInt(key) > cutoff) { state.messageCache.delete(key); trimmed = true; }
      }
      if (trimmed) recomputeFromCache();
    }

    for (const item of items) {
      const idx = item.getAttribute('data-index');
      if (state.messageCache.has(idx)) continue;

      const feedEl = item.querySelector('[class*="feedMessage"]');
      if (!feedEl) continue;
      if (!isOpaque(feedEl)) continue;

      const playerName = getPlayerName(feedEl);
      if (!playerName || !state.players.has(playerName)) {
        state.messageCache.set(idx, null);
        continue;
      }

      const data = { playerName, text: feedEl.textContent.trim(), html: feedEl.innerHTML };
      state.messageCache.set(idx, data);
      parseMessage(data.playerName, data.text, data.html);
    }
    updatePanel();
  }

  function startObserver() {
    const feedContainer = document.querySelector('[class*="gameFeedsContainer"]');
    if (!feedContainer) return false;
    const scroller = feedContainer.querySelector('[class*="virtualScroller"]');
    if (!scroller) return false;

    processFeedItems(scroller);

    state.observer = new MutationObserver(() => { processFeedItems(scroller); });
    state.observer.observe(scroller, { childList: true });

    const scrollParent = scroller.parentElement;
    if (scrollParent) {
      scrollParent.addEventListener('scroll', () => { processFeedItems(scroller); }, { passive: true });
    }

    console.log('[CatanCounter] Observer started');
    return true;
  }

  // ======================== Init ========================

  function init() {
    detectPlayers();
    if (!state.myUsername || state.playerOrder.length < 2) return false;

    detectImageUrls();
    createPanel();

    if (startObserver()) {
      console.log('[CatanCounter] Ready — me:', state.myUsername, '| players:', state.playerOrder.join(', '));
      return true;
    }
    return false;
  }

  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (init() || attempts > 60) {
      clearInterval(interval);
      if (attempts > 60) console.log('[CatanCounter] Gave up waiting for game');
    }
  }, 1000);
})();
