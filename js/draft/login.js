import { auth } from './firebase.js';
import { signInWithEmailAndPassword, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getUserProfile } from './service.js';
const $=id=>document.getElementById(id);
async function route(user){const p=await getUserProfile(user.uid);if(p?.role==='admin') location.replace('draft-control.html'); else if(p?.role==='team'&&p?.teamId) location.replace('team-dashboard.html'); else throw new Error('Für dieses Konto ist keine gültige Rolle hinterlegt.');}
$('loginBtn').onclick=async()=>{try{$('loginError').textContent='';const c=await signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value);await route(c.user);}catch(e){$('loginError').textContent=/invalid-credential/i.test(e?.code||'')?'E-Mail oder Passwort ist nicht korrekt.':e.message;}};
$('password').addEventListener('keydown',e=>{if(e.key==='Enter')$('loginBtn').click();});
onAuthStateChanged(auth,user=>{if(user)route(user).catch(e=>$('loginError').textContent=e.message);});
