(() => {
  /**********************  CONFIG  **************************/
  const TICK_MS = 500;
  const INITIAL_SETTLE_TICKS = 4;
  const VS_WINDOW = 3;

  // Cooldowns (shortened for more frequent alarms)
  const SINKRATE_COOLDOWN_MS = 4000;   // was 7000
  const PULLUP_COOLDOWN_MS = 5000;     // was 9000
  const BANK_COOLDOWN_MS = 7000;
  const DONT_SINK_COOLDOWN_MS = 9000;
  const TOOLowFLAPS_COOLDOWN_MS = 12000;
  const STALL_COOLDOWN_MS = 5000;

  const CALLOUT_GRACE_1000_500_MS = 5000;
  const CALLOUT_GRACE_100_MS = 2000;

  const CALLOUTS = [1000, 500, 100, 50, 40, 30, 20, 10];
  const MINIMUMS_ALT_FT = 185;

  const STALL_KTS = 130;
  const STALL_HYSTERESIS_KTS = 5;
  const STALL_MIN_ALT_FT = 50;

  // Sinkrate thresholds
  function sinkrateThreshold(altFeet) {
    if (altFeet >= 2500) return -4000;
    if (altFeet >= 1000) return -3000;
    if (altFeet >= 500)  return -2000;
    if (altFeet >= 100)  return -1500;
    return -1200;
  }
  function pullupThreshold(altFeet) {
    if (altFeet >= 1000) return -5000;
    if (altFeet >= 500)  return -4000;
    return -3500;
  }

  const BANK_WARN_DEG = 45;
  const BANK_WARN_LOW_ALT_DEG = 40;
  const RESET_ALT_FT = 1200;

  // Sounds
  const sounds = {
    "1000": "https://arnav2019dk-boop.github.io/geofssounds/1000.mp3",
    "500":  "https://arnav2019dk-boop.github.io/geofssounds/500.mp3",
    "100":  "https://arnav2019dk-boop.github.io/geofssounds/plus100.mp3",
    "50":   "https://arnav2019dk-boop.github.io/geofssounds/50.mp3",
    "40":   "https://arnav2019dk-boop.github.io/geofssounds/40.mp3",
    "30":   "https://arnav2019dk-boop.github.io/geofssounds/30.mp3",
    "20":   "https://arnav2019dk-boop.github.io/geofssounds/20.mp3",
    "10":   "https://arnav2019dk-boop.github.io/geofssounds/10.mp3",

    "minimums":    "https://arnav2019dk-boop.github.io/geofssounds/minimums.mp3",
    "stall":       "https://arnav2019dk-boop.github.io/geofssounds/stall.mp3",

    "warning":     "https://arnav2019dk-boop.github.io/geofssounds/warning.mp3",
    "sinkrate":    "https://arnav2019dk-boop.github.io/geofssounds/sinkrate.mp3",
    "pullup":      "https://arnav2019dk-boop.github.io/geofssounds/pullup.mp3",
    "bankangle":   "https://arnav2019dk-boop.github.io/geofssounds/bankangle.mp3",
    "dontsink":    "https://arnav2019dk-boop.github.io/geofssounds/dontsink.mp3",
    "toolowflaps": "https://arnav2019dk-boop.github.io/geofssounds/toolowflaps.mp3",

    "autopilotdisc":"https://arnav2019dk-boop.github.io/geofssounds/autopilotdisc.mp3",
  };

  /**********************  AUDIO  **************************/
  const audio = {};
  for (let [k, url] of Object.entries(sounds)) {
    const a = new Audio(url);
    a.preload = "auto";
    a.crossOrigin = "anonymous";
    audio[k] = a;
  }

  let audioUnlocked = false;
  const unlockOnce = () => {
    if (!audioUnlocked) {
      audioUnlocked = true;
      console.log("✅ Audio unlocked by user interaction");
    }
  };
  window.addEventListener("pointerdown", unlockOnce, { once: true, capture: true });
  window.addEventListener("keydown", unlockOnce, { once: true, capture: true });

  function playSound(name, delayMs = 0) {
    if (!audioUnlocked) return;
    const snd = audio[name];
    if (!snd) return;
    setTimeout(() => {
      try {
        snd.currentTime = 0;
        snd.play().then(()=>{}).catch(()=>{});
        console.log("🔊 GPWS:", name);
      } catch {}
    }, delayMs);
  }

  /**********************  STATE  **************************/
  let tick = 0;
  let lastAlt = null;
  let lastAP = (geofs && geofs.autopilot && geofs.autopilot.engaged) || false;

  let calloutsDone = {};
  let minimumsDone = false;
  let sinkrateGraceUntil = 0;

  const lastWarn = {
    sinkrate: 0,
    pullup: 0,
    bank: 0,
    dontsink: 0,
    toolowflaps: 0,
    stall: 0
  };

  let stallLatched = false;
  const vsBuf = [];
  function avg(arr){return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;}

  function getAGL(){return Number.isFinite(geofs?.animation?.values?.haglFeet)?geofs.animation.values.haglFeet:0;}
  function getVSfpm(){return Number.isFinite(geofs?.animation?.values?.verticalSpeed)?geofs.animation.values.verticalSpeed:0;}
  function getBankDeg(){
    const r=geofs?.animation?.values?.roll||0;const a=Math.abs(r);
    return (a<=3.5)?Math.abs(r*180/Math.PI):a;
  }
  function getFlaps(){return geofs?.animation?.values?.flapsPosition??0;}
  function getAP(){return geofs?.autopilot?.engaged||false;}
  function getIASKnots(){
    const v=geofs?.animation?.values||{};
    const c=[["kias",v.kias],["indicatedAirspeed",v.indicatedAirspeed],["ias",v.ias],["KIAS",v.KIAS],["kcas",v.kcas],["cas",v.cas],["trueAirspeed",v.trueAirspeed],["tas",v.tas],["airspeed",v.airspeed],["airSpeed",v.airSpeed],["groundSpeed",v.groundSpeed],["gs",v.gs]];
    for(const [n,raw] of c){const x=Number(raw);if(Number.isFinite(x)){let k=x;if(x>5&&x<40){k=x*1.943844;}else if(x>=400&&x<1200){k=x*0.539957;}return{kts:k,src:n};}}
    return{kts:null,src:null};
  }

  function resetApproach(){calloutsDone={};minimumsDone=false;sinkrateGraceUntil=0;stallLatched=false;}

  /**********************  MAIN LOOP  **************************/
  function runGPWS(){
    tick++;
    const alt=getAGL(), vs=getVSfpm(), bank=getBankDeg(), flaps=getFlaps(), {kts:iasKts}=getIASKnots();
    vsBuf.push(vs); if(vsBuf.length>3)vsBuf.shift(); const vsAvg=avg(vsBuf);
    console.log(`ALT:${alt.toFixed(1)} VS:${vs.toFixed(0)} BANK:${bank.toFixed(1)} FLAPS:${flaps.toFixed(0)} IAS:${iasKts==null?"?":iasKts.toFixed(0)}`);
    if(tick<=INITIAL_SETTLE_TICKS){lastAlt=alt;lastAP=getAP();return;}
    if(alt>RESET_ALT_FT)resetApproach();

    // Callouts
    if(lastAlt!=null){
      for(const thr of CALLOUTS){if(!calloutsDone[thr]&&lastAlt>thr&&alt<=thr){playSound(thr.toString());calloutsDone[thr]=true;if(thr===1000||thr===500){sinkrateGraceUntil=Math.max(sinkrateGraceUntil,Date.now()+CALLOUT_GRACE_1000_500_MS);}else if(thr===100){sinkrateGraceUntil=Math.max(sinkrateGraceUntil,Date.now()+CALLOUT_GRACE_100_MS);}}}
      if(!minimumsDone&&lastAlt>MINIMUMS_ALT_FT&&alt<=MINIMUMS_ALT_FT){playSound("minimums");minimumsDone=true;}
    }

    const now=Date.now();

    // Sinkrate
    if(now>=sinkrateGraceUntil && vsAvg<sinkrateThreshold(alt) && now-lastWarn.sinkrate>SINKRATE_COOLDOWN_MS){
      playSound("warning"); playSound("sinkrate",1000);
      lastWarn.sinkrate=now;
    }

    // Pullup
    if(vsAvg<pullupThreshold(alt) && now-lastWarn.pullup>PULLUP_COOLDOWN_MS){
      playSound("warning"); playSound("pullup",1000);
      lastWarn.pullup=now;
    }

    // Bank
    if(((alt<1000&&bank>=BANK_WARN_LOW_ALT_DEG)||(bank>=BANK_WARN_DEG))&&now-lastWarn.bank>BANK_COOLDOWN_MS){
      playSound("warning"); playSound("bankangle",1000);
      lastWarn.bank=now;
    }

    // Dont sink
    if(alt<300&&vsAvg>400&&now-lastWarn.dontsink>DONT_SINK_COOLDOWN_MS){playSound("dontsink");lastWarn.dontsink=now;}

    // Too low flaps
    if(alt<400&&flaps<1&&now-lastWarn.toolowflaps>TOOLowFLAPS_COOLDOWN_MS){playSound("toolowflaps");lastWarn.toolowflaps=now;}

    // Stall
    if(iasKts!=null&&alt>STALL_MIN_ALT_FT){
      const below=iasKts<STALL_KTS,recovered=iasKts>STALL_KTS+STALL_HYSTERESIS_KTS;
      if(below){if(!stallLatched&&now-lastWarn.stall>STALL_COOLDOWN_MS){playSound("stall");lastWarn.stall=now;stallLatched=true;}}
      else if(recovered){stallLatched=false;}
    }else if(iasKts!=null&&iasKts>STALL_KTS+STALL_HYSTERESIS_KTS){stallLatched=false;}

    // AP disc
    const ap=getAP(); if(lastAP&& !ap){playSound("autopilotdisc");} lastAP=ap;
    lastAlt=alt;
  }

  const timer=setInterval(runGPWS,TICK_MS);
  window.addEventListener("keydown",e=>{if(e.key.toLowerCase()==="g"&&e.shiftKey){resetApproach();for(const k of Object.keys(lastWarn))lastWarn[k]=0;vsBuf.length=0;console.log("🔁 GPWS reset");}});
})();
