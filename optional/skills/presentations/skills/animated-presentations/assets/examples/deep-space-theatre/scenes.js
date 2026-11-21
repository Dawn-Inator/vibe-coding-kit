/* Original Kit-authored scenes. Semantic state is independent of playback time. */
(() => {
  'use strict';
  const clamp = p => Math.max(0, Math.min(1, p));
  const ease = p => 1 - (1 - clamp(p)) ** 3;
  const smooth = p => { p = clamp(p); return p * p * (3 - 2 * p); };
  const segment = (p, a, b) => clamp((p - a) / (b - a));
  const mix = (a, b, p) => a + (b - a) * p;
  const $ = (section, selector) => section.querySelector(selector);
  const $$ = (section, selector) => [...section.querySelectorAll(selector)];
  const alpha = (el, p) => {
    if (!el) return;
    const a = clamp(p);
    el.style.opacity = String(a);
    el.style.visibility = a < .001 ? 'hidden' : 'visible';
    el.setAttribute('aria-hidden', String(a < .001));
  };
  const steps = (durations, render) => durations.map((durationMs, index) => ({durationMs, render: p => render(index, clamp(p))}));
  const completed = (itemStep, step, p) => itemStep < step ? 1 : itemStep === step ? smooth(p) : 0;
  // Sample immutable geometry once. Frame rendering makes no layout measurements.
  function track(path) {
    const length = path.getTotalLength();
    const points = Array.from({length:257}, (_, i) => {
      const point = path.getPointAtLength(i / 256 * length);
      return {x:point.x, y:point.y};
    });
    path.style.strokeDasharray = `${length} ${length}`;
    return {
      draw(p) { path.style.strokeDashoffset = String(length * (1 - clamp(p))); },
      point(p) {
        const t = clamp(p) * 256, i = Math.min(255, Math.floor(t)), u = t - i;
        return {x:mix(points[i].x, points[i+1].x, u), y:mix(points[i].y, points[i+1].y, u)};
      }
    };
  }
  const place = (el, point) => { el.setAttribute('cx', point.x); el.setAttribute('cy', point.y); };
  const palette = {amber:'#e9bd82', cyan:'#8bd9cf', blue:'#78b9d9'};

  function coverScene(section) {
    const arc = track($(section,'.cover-arc'));
    const check = track($(section,'.cover-check'));
    const packet = $(section,'.cover-packet');
    const deck = $(section,'.cover-deck');
    return {
      transitionMs:1100,
      theme:{light:[.8,.54],tint:'#92a8be',level:.88,cameraX:0},
      steps:steps([1900,1200], (step,p) => {
        const trace = completed(0,step,p), resolve = completed(1,step,p);
        arc.draw(trace); place(packet,arc.point(trace));
        alpha(packet,trace < .999 ? smooth(segment(trace,0,.15)) : .55);
        check.draw(resolve); alpha($(section,'.cover-check'),resolve);
        alpha(deck,.45+.55*(step===0?ease(segment(p,.18,.75)):1));
      }),
      getTheme:({step,progress,timeMs}) => ({
        objects:[{id:'delivery-world',kind:'planet',x:1240,y:440,radius:222,rotation:.4+timeMs*.000018,
          reveal:.62+.38*completed(0,step,progress),color:'#719fae'}]
      })
    };
  }

  function atlasScene(section) {
    const route = track($(section,'.atlas-route'));
    const marker = $(section,'.atlas-marker');
    const stops = $$(section,'.atlas-stop');
    const landing = $(section,'.atlas-landing');
    const xs = [320,800,1280];
    return {
      transitionMs:1250,
      transitionAxis:'vertical',
      theme:{light:[.5,.56],tint:'#a7a887',level:.88,cameraX:90},
      steps:steps([900,1100,1100,1300], (step,p) => {
        const travel = step===0 ? .1*smooth(p) : mix((step-1)/3,step/3,smooth(p));
        route.draw(travel); place(marker,route.point(travel));alpha(marker,.9);
        stops.forEach((stop,i) => {
          const active = completed(i+1,step,p);
          alpha(stop,.38+.62*active);
          stop.style.transform=`translateY(${12*(1-active)}px)`;
        });
        alpha(landing,completed(3,step,p));
      }),
      getTheme:({step,progress,timeMs}) => ({objects:xs.map((x,i) => ({
        id:`atlas-${i}`,kind:i===2?'network':'planet',x,y:i===1?427:423,radius:i===2?122:126,
        rotation:[.4,-.3,.2][i]+timeMs*(i===1?-.000018:.00002),
        reveal:.28+.72*completed(i+1,step,progress),color:[palette.amber,palette.blue,palette.cyan][i]
      }))})
    };
  }

  function processScene(section) {
    const route = track($(section,'.route-progress'));
    const packet = $(section,'.route-packet');
    const nodes = $$(section,'.route-node');
    const labels = $$(section,'.route-labels b');
    const pieces = $$(section,'.workpiece');
    const asides = $$(section,'[data-aside]');
    const prompts = $$(section,'.request-prompts span');
    const contractRows = $$(section,'.contract-row');
    const files = $$(section,'.build-files div');
    const beamCircle = $(section,'.build-beam circle');
    const receiptItems = $$(section,'.receipt-items div');
    const outputTitle = $(section,'.process-output strong');
    const outputCopy = $(section,'.process-output span');
    const outputTitles = ['待澄清的需求','验收约定','可运行的版本','可复核的记录'];
    const outputCopies = ['意图被说出来，\n问题开始浮现。','目标、行为与边界，\n成为共同坐标。','实现与关键路径，\n接受独立检查。','版本、行为与证据，\n留在同一处。'];
    return {
      theme:{light:[.63,.5],tint:'#609b9a',level:.42,cameraX:150,objects:[]},
      steps:steps([1400,1700,1700,1750], (step,p) => {
        const t=smooth(p), previous=Math.max(0,step-1)/3, target=step/3;
        const travel=mix(previous,target,ease(segment(p,0,.7)));
        route.draw(travel);place(packet,route.point(travel));alpha(packet,1);
        nodes.forEach((node,i) => {node.classList.toggle('is-reached',i<=step);node.classList.toggle('is-current',i===step);});
        labels.forEach((label,i)=>label.classList.toggle('is-current',i===step));
        pieces.forEach((piece,i)=>{
          alpha(piece,i===step?.35+.65*ease(segment(p,.12,.7)):0);
          piece.style.transform=`translateY(${i===step?18*(1-t):0}px) scale(${i===step?.96+.04*t:1})`;
        });
        asides.forEach((aside,i)=>alpha(aside,i===step?1:0));
        prompts.forEach((prompt,i)=>alpha(prompt,step===0?smooth(segment(p,.18+i*.19,.43+i*.19)):1));
        contractRows.forEach((row,i)=>{
          const q=step===1?ease(segment(p,.1+i*.17,.47+i*.17)):1;
          alpha(row,q);row.style.transform=`translateX(${26*(1-q)}px)`;
        });
        files.forEach((file,i)=>{
          const q=step===2?smooth(segment(p,.12+i*.17,.46+i*.17)):1;
          alpha(file,q);file.style.transform=`translateY(${16*(1-q)}px)`;
        });
        beamCircle.setAttribute('cx',55+490*t);beamCircle.setAttribute('cy',23);
        alpha(beamCircle,step===2?smooth(segment(p,.15,.4)):0);
        receiptItems.forEach((item,i)=>alpha(item,step===3?smooth(segment(p,.1+i*.18,.42+i*.18)):1));
        alpha($(section,'.receipt-stamp'),step===3?smooth(segment(p,.7,.98)):1);
        outputTitle.textContent=outputTitles[step];outputCopy.textContent=outputCopies[step];
      })
    };
  }

  function comparisonScene(section) {
    const rows=$$(section,'.comparison-row');
    const links=$$(section,'.comparison-links g').map(group=>({
      route:track(group.querySelector('path')),path:group.querySelector('path'),packet:group.querySelector('circle')
    }));
    return {
      theme:{light:[.78,.49],tint:'#72a9a5',level:.33,cameraX:190,objects:[]},
      steps:steps([650,1600,1600,1750], (step,p) => {
        rows.forEach((row,i)=>{
          const q=completed(i+1,step,p);
          const behavior=$(row,'.behavior');
          alpha(behavior,.12+.88*q);
          behavior.style.transform=`translateX(${18*(1-q)}px)`;
          $(row,'.clue h3').style.color=step===i+1?'#e9bd82':'#c3cecd';
          const mark=$(row,'.verify-mark');
          const markProgress=step>i+1?1:step===i+1?smooth(segment(p,.6,.95)):0;
          alpha(mark,markProgress);mark.style.transform=`scale(${.7+.3*markProgress})`;
          links[i].route.draw(q);alpha(links[i].path,.18+.82*q);
          place(links[i].packet,links[i].route.point(q));
          alpha(links[i].packet,q>.001&&q<.999?1:0);
        });
        alpha($(section,'.comparison-landing'),completed(3,step,p));
      })
    };
  }

  function evidenceScene(section) {
    const notes=$$(section,'.evidence-note');
    const focus=$(section,'.evidence-focus');
    const image=$(section,'.evidence-open img');
    const lerpBox=(a,b,p)=>a.map((v,i)=>mix(v,b[i],p));
    let boxes=[],rowHeight=0;
    function measure(){
      const canvas=section.getBoundingClientRect(),rect=image.getBoundingClientRect();
      const scale=canvas.width/1600||1;
      const art={x:(rect.left-canvas.left)/scale,y:(rect.top-canvas.top)/scale,w:rect.width/scale,h:rect.height/scale};
      const toStage=([x,y,w,h])=>[art.x+x/1200*art.w,art.y+y/650*art.h,w/1200*art.w,h/650*art.h];
      boxes=[[58,573,1084,55],[58,277,1084,93],[984,277,158,279]].map(toStage);
      rowHeight=93/650*art.h;
    }
    measure();
    return {
      transitionMs:850,
      measure,
      theme:{light:[.88,.65],tint:'#507d82',level:.16,cameraX:200,objects:[]},
      steps:steps([1000,1700,1400],(step,p)=>{
        notes.forEach((note,i)=>{
          alpha(note,i<=step?1:.35);note.classList.toggle('is-current',i===step);
        });
        const from=step===0?boxes[0]:boxes[step-1];
        const to=boxes[step];
        const b=lerpBox(from,to,ease(segment(p,0,.75)));
        // The focus moves through the record's own coordinates; the original image stays still.
        if(step===1)b[1]+=2*rowHeight*smooth(segment(p,.4,1));
        if(step===2)b[1]=mix(boxes[1][1]+2*rowHeight,boxes[2][1],ease(segment(p,0,.75)));
        focus.style.left=`${b[0]}px`;focus.style.top=`${b[1]}px`;
        focus.style.width=`${b[2]}px`;focus.style.height=`${b[3]}px`;
        alpha(focus,.4+.6*smooth(segment(p,0,.35)));
      })
    };
  }

  function closingScene(section) {
    const ring=track($(section,'.closing-ring'));
    const check=track($(section,'.closing-check'));
    const packet=$(section,'.closing-packet');
    return {
      transitionMs:1400,
      transitionAxis:'vertical',
      theme:{light:[.8,.54],tint:'#96b49e',level:.7,cameraX:270},
      steps:steps([1800,1500],(step,p)=>{
        const q=completed(0,step,p),r=completed(1,step,p);
        ring.draw(q);place(packet,ring.point(q));alpha(packet,q<.999?1:0);
        check.draw(r);alpha($(section,'.closing-check'),r);
        alpha($(section,'.closing-action'),.4+.6*r);
        $$(section,'.closing-route span').forEach((el,i)=>alpha(el,.35+.65*(step===1?smooth(segment(p,i*.13,.48+i*.13)):0)));
      }),
      getTheme:({step,progress,timeMs})=>({objects:[{
        id:'delivery-world',kind:'ring',x:1220,y:445,radius:149,rotation:.25+timeMs*.000015,
        reveal:.4+.6*completed(0,step,progress),color:'#8cbdad'
      }]})
    };
  }

  const stage=document.getElementById('stage');
  const viewport=document.getElementById('viewport');
  function fitStage(){
    const ratio=Math.min(viewport.clientWidth/1600,viewport.clientHeight/900);
    stage.style.transform=`translate(-50%,-50%) scale(${ratio})`;
  }
  fitStage();addEventListener('resize',fitStage);
  const theme=createDeepSpaceTheme(document.getElementById('space-layer'),{
    width:1600,height:900,seed:20261121,webgl:new URLSearchParams(location.search).get('webgl')!=='0'
  });
  const sceneDefinitions={cover:coverScene,atlas:atlasScene,process:processScene,comparison:comparisonScene,evidence:evidenceScene,closing:closingScene};
  window.proof=createPresenter({stage,sceneDefinitions,theme});
  const proof=window.proof;
  const byId=id=>document.getElementById(id);
  byId('previous-page').onclick=()=>proof.prevPage();
  byId('next-page').onclick=()=>proof.nextPage();
  byId('previous-step').onclick=()=>proof.prevStep();
  byId('next-step').onclick=()=>proof.nextStep();
  byId('replay').onclick=()=>proof.replay();
  byId('pause').onclick=()=>proof.getState().paused?proof.play():proof.pause();
  byId('seek').addEventListener('input',e=>proof.seek(Number(e.target.value)));
  proof.onChange(state=>{
    byId('page-label').textContent=`${String(state.currentPage+1).padStart(2,'0')} / ${String(state.totalPages).padStart(2,'0')}`;
    const text=`步骤 ${state.step+1} / ${state.stepCount}`;
    if(byId('step-label').textContent!==text)byId('step-label').textContent=text;
    byId('seek').value=String(state.progress);
    byId('pause').textContent=state.paused?'播放':'暂停';
    byId('previous-page').disabled=state.currentPage===0;
    byId('next-page').disabled=state.currentPage===state.totalPages-1;
    byId('previous-step').disabled=state.currentPage===0&&state.step===0;
    byId('next-step').disabled=state.currentPage===state.totalPages-1&&state.step===state.stepCount-1;
  });
  const dialog=byId('evidence-dialog');
  document.querySelector('.evidence-open').onclick=()=>{proof.pause();dialog.showModal();};
  dialog.querySelector('.dialog-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
})();
