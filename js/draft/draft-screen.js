import { DRAFT } from './config.js';
import { watchBoard, watchState, reconcileDraftState, timestampMs } from './service.js';
import { getNextOpenSlot, orderedPicks, teamNeeds } from './model.js';
import { loadRankings, bestAvailable } from './rankings.js';
import { loadSleeperPlayers } from './players.js';
import { unlockAudio, announcePick, announceClock } from './audio.js';

let board={teams:[],picks:{}}, state={}, players=[], rankingsReady=false, lastPickOverall=0, lastTeam=null;
const $=id=>document.getElementById(id);
$('season').textContent=DRAFT.season;
$('audioUnlock').onclick=()=>{unlockAudio(); $('audioUnlock').textContent='🔊 Audio bereit';};

Promise.allSettled([loadRankings(),loadSleeperPlayers()]).then(([r,p])=>{rankingsReady=r.status==='fulfilled'; if(p.status==='fulfilled') players=p.value; render();});
watchState(s=>{state=s; renderTimers();});
watchBoard(async b=>{const before=lastPickOverall; board=b; $('sync').textContent='LIVE'; $('sync').style.color='#40e0a1'; await reconcileDraftState(b).catch(()=>{}); render(); const ordered=orderedPicks(b.picks||{}); const latest=ordered.at(-1); if(latest && latest.overall>before){ lastPickOverall=latest.overall; showPick(latest); } else lastPickOverall=latest?.overall||0;},()=>{$('sync').textContent='OFFLINE';});
setInterval(renderTimers,250);

function render(){
 const next=getNextOpenSlot(board.picks||{}); if(!next){$('teamName').textContent='DRAFT COMPLETE';return;}
 const teamName=board.teams?.[next.position-1]||`Position ${next.position}`;
 $('teamName').textContent=teamName; $('pickMeta').textContent=`Runde ${next.round} · Overall Pick #${next.overall}`;
 setLogo($('teamLogo'),teamName);
 const teamPicks=orderedPicks(board.picks||{}).filter(p=>board.teams?.[p.position-1]===teamName);
 const needs=teamNeeds(teamPicks).needs; $('needsList').innerHTML=(needs.length?needs:[{position:'DEPTH'}]).map(n=>`<span>${n.position}${n.missing?` ×${n.missing}`:''}</span>`).join('');
 const picked=new Set(Object.values(board.picks||{}).map(p=>p.name));
 const avail=rankingsReady?bestAvailable(picked,10):[]; $('availableList').innerHTML=avail.map((p,i)=>`<li><span class="rank">${i+1}</span><div><div class="pname">${esc(p.name)}</div><div class="pmeta">${esc(p.team||'')} · ADP ${Number(p.adp).toFixed(1)}${p.bye?` · Bye ${p.bye}`:''}</div></div><span class="pos">${p.position}</span></li>`).join('')||'<li>Ranking-Feed wird geladen…</li>';
 const recent=orderedPicks(board.picks||{}).slice(-5).reverse(); $('recentList').innerHTML=recent.map(p=>`<div class="recent-item"><strong>#${p.overall} ${esc(p.name)}</strong><span>${esc(board.teams?.[p.position-1]||'')} · ${p.position} ${esc(p.nflTeam||'')}</span></div>`).join('');
 if(teamName!==lastTeam && lastTeam!==null) announceClock(teamName); lastTeam=teamName;
}
function renderTimers(){ const start=timestampMs(state.clockStartedAt); if(start){$('pickTimer').textContent=fmt(Date.now()-start);} const due=timestampMs(state.autoPickDueAt); const next=getNextOpenSlot(board.picks||{}); const active=due&&next&&state.autoPickForOverall===next.overall; $('autoWrap').hidden=!active; if(active)$('autoTimer').textContent=fmt(Math.max(0,due-Date.now()),true); }
function showPick(p){ const teamName=board.teams?.[p.position-1]||''; const player=players.find(x=>x.name.toLowerCase()===p.name.toLowerCase()); $('pickNumber').textContent=`ROUND ${p.round} · PICK #${p.overall}`; $('pickPlayer').textContent=p.name; $('pickPosition').textContent=p.position; $('pickNfl').textContent=p.nflTeam||''; $('pickFantasyTeam').textContent=teamName; $('pickPhoto').src=player?.headshot||''; const o=$('pickOverlay');o.classList.add('show'); announcePick({overall:p.overall,season:DRAFT.season,teamName,player:p}); setTimeout(()=>{o.classList.remove('show'); showNext();},5200); }
function showNext(){ const next=getNextOpenSlot(board.picks||{}); if(!next)return; const name=board.teams?.[next.position-1]||''; $('nextTeam').textContent=name; setLogo($('nextLogo'),name); const n=$('nextOverlay'); n.classList.add('show'); setTimeout(()=>n.classList.remove('show'),2600); }
function fmt(ms,countdown=false){const s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60),r=s%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;}
function setLogo(el,name){const slug=name.toLowerCase().replace(/ü/g,'u').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); const known={"amity island sharks":"amity_island_sharks","beard":"beard","bishop sycamore":"bishop_sycamore","bojangles p-stars":"bojangles_pstars","brady gaga":"brady_gaga","broken bembels ulb":"broken_bembels","e-town elephants":"etown_elephants","fighting farmers":"fighting_farmers","foxboro forever":"foxboro_forever","frankfurt bakers":"frankfurt_bakers","k-town devils":"ktown_devils","packers ultras":"packers_ultras","pep's band":"peps_band","randy moss lob jünger":"randy_moss","steelersnation 7":"steelersnation","the 49vengers":"the49vengers","the boys":"the_boys","thunder ducks":"thunder_ducks","wiesbaden phantoms":"wiesbaden_phantoms","zeugen ray lewis":"zeugen_ray_lewis"};el.src=`images/${known[name.toLowerCase()]||slug}.jpg`;el.onerror=()=>{el.style.visibility='hidden'};el.style.visibility='visible';}
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
