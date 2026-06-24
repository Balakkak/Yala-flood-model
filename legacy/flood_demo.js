(function(){
  const cv=document.getElementById('cv'),ctx=cv.getContext('2d');
  const W=680,H=430,cols=85,rows=54,cw=W/cols,ch=H/rows;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  function chX(ny){return 0.05 + 0.05*Math.sin(ny*5.8-1.0);} // fallback for particles
  const elev=new Float32Array(cols*rows);
  for(let r=0;r<rows;r++){for(let c=0;c<cols;c++){
    const nx=(c+0.5)/cols, ny=(r+0.5)/rows;
    let distToRiver = Math.min(nx, ny); 
    let curve = 0.05 * Math.sin(ny * 10) + 0.05 * Math.sin(nx * 10);
    distToRiver += curve;
    let e = Math.max(0, distToRiver * 1.5);
    const bd = Math.hypot(nx-0.4, ny-0.5);
    e -= Math.max(0, (0.15 - bd) / 0.15) * 0.15;
    const bd2 = Math.hypot(nx-0.7, ny-0.3);
    e -= Math.max(0, (0.1 - bd2) / 0.1) * 0.1;
    elev[r*cols+c]=Math.max(0,Math.min(1,e));
  }}
  const terr=document.createElement('canvas');terr.width=W;terr.height=H;
  const tx=terr.getContext('2d');
  function lerp(a,b,t){return a+(b-a)*t;}
  function terrCol(e){
    if(e<0.05)return[206,224,234];
    let r,g,b;
    if(e<0.45){const t=(e-0.05)/0.40;r=lerp(183,214,t);g=lerp(208,205,t);b=lerp(150,164,t);}
    else{const t=(e-0.45)/0.55;r=lerp(214,201,t);g=lerp(205,198,t);b=lerp(164,189,t);}
    return[r,g,b];
  }
  for(let r=0;r<rows;r++){for(let c=0;c<cols;c++){
    const co=terrCol(elev[r*cols+c]);
    tx.fillStyle='rgb('+(co[0]|0)+','+(co[1]|0)+','+(co[2]|0)+')';
    tx.fillRect(Math.floor(c*cw),Math.floor(r*ch),Math.ceil(cw)+1,Math.ceil(ch)+1);
  }}
  function O(){return[0.10, 0.20];}
  const pipes=[
    [[0.45,0.55],[0.30,0.40],O()],
    [[0.75,0.35],[0.50,0.30],O()],
    [[0.60,0.70],[0.35,0.50],O()]
  ];
  let particles=[];for(let i=0;i<10;i++)particles.push(i/10);
  let t=0,playing=false,dash=0,raf=null;
  let floodSpeed=0.0045, floodDepth=0.52;
  function npx(p){return[p[0]*W,p[1]*H];}
  function draw(){
    ctx.clearRect(0,0,W,H);
    // ctx.drawImage(terr,0,0); // ลบพื้นหลังจำลองออก เพื่อให้เห็นแผนที่ Leaflet ด้านหลัง
    const level=t*floodDepth;
    // เพิ่ม Wave Distance เพื่อบังคับให้น้ำไหลมาจากแม่น้ำปัตตานี (ซ้ายบน) เท่านั้น
    const waveDist = t * 1.5; 
    for(let r=0;r<rows;r++){for(let c=0;c<cols;c++){
      const nx=(c+0.5)/cols, ny=(r+0.5)/rows;
      // น้ำจะท่วมก็ต่อเมื่อคลื่นน้ำแผ่มาจากแม่น้ำปัตตานีไปถึงพื้นที่นั้นแล้ว
      if (Math.min(nx, ny) <= waveDist) {
        const d=level-elev[r*cols+c];
        if(d>0){
          let a,col;
          if(d<0.035){col='126,200,230';a=0.85;}
          else{const dd=Math.min(d/0.30,1);a=0.45+dd*0.45;col=Math.round(lerp(110,12,dd))+','+Math.round(lerp(170,63,dd))+','+Math.round(lerp(210,99,dd));}
          ctx.fillStyle='rgba('+col+','+a+')';
          ctx.fillRect(Math.floor(c*cw),Math.floor(r*ch),Math.ceil(cw)+1,Math.ceil(ch)+1);
        }
      }
    }}
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
    for(const pp of pipes){
      ctx.beginPath();const s=npx(pp[0]);ctx.moveTo(s[0],s[1]);
      for(let i=1;i<pp.length;i++){const q=npx(pp[i]);ctx.lineTo(q[0],q[1]);}
      ctx.strokeStyle='rgba(70,60,50,0.55)';ctx.lineWidth=5;ctx.setLineDash([]);ctx.stroke();
      ctx.beginPath();ctx.moveTo(s[0],s[1]);
      for(let i=1;i<pp.length;i++){const q=npx(pp[i]);ctx.lineTo(q[0],q[1]);}
      ctx.strokeStyle='#e8a13a';ctx.lineWidth=2.4;ctx.setLineDash([7,7]);ctx.lineDashOffset=-dash;ctx.stroke();
      const a=npx(pp[pp.length-2]),b=npx(pp[pp.length-1]);
      const ang=Math.atan2(b[1]-a[1],b[0]-a[0]);
      ctx.setLineDash([]);ctx.fillStyle='#d98a25';
      ctx.beginPath();ctx.moveTo(b[0],b[1]);
      ctx.lineTo(b[0]-9*Math.cos(ang-0.4),b[1]-9*Math.sin(ang-0.4));
      ctx.lineTo(b[0]-9*Math.cos(ang+0.4),b[1]-9*Math.sin(ang+0.4));
      ctx.closePath();ctx.fill();
    }
    ctx.restore();
    const o=npx(O());
    ctx.fillStyle='#8a5523';ctx.fillRect(o[0]-15,o[1]-7,30,14);
    ctx.strokeStyle='#f0e3d4';ctx.lineWidth=1.4;
    for(let i=-1;i<2;i++){ctx.beginPath();ctx.moveTo(o[0]+i*8,o[1]-7);ctx.lineTo(o[0]+i*8,o[1]+7);ctx.stroke();}
    ctx.fillStyle='rgba(170,210,232,0.9)';
    for(const p of particles){
      const px = (0.05 + 0.02*Math.sin(p*20)) * W;
      const py = p * H;
      ctx.beginPath();ctx.arc(px,py,2.2,0,7);ctx.fill();
    }
    label('แม่น้ำปัตตานี (Pattani River)',0.15*W,0.1*H);
    label('พื้นที่ลุ่มต่ำในเมือง',0.4*W,0.5*H);
    label('พื้นที่สูง (ใจกลางเมือง)',0.75*W,0.75*H);
    label('ท่อระบายน้ำ',0.35*W,0.45*H);
    label('สถานีสูบน้ำ',o[0]+20,o[1]+25);
  }
  function label(s,x,y){
    ctx.font='600 12px sans-serif';const w=ctx.measureText(s).width;
    let lx=x-w/2;lx=Math.max(4,Math.min(W-w-12,lx));
    ctx.fillStyle='rgba(255,255,255,0.82)';
    ctx.fillRect(lx-5,y-12,w+10,17);
    ctx.fillStyle='#33312c';ctx.textBaseline='alphabetic';ctx.fillText(s,lx,y);
  }
  const sld=document.getElementById('sld'),tlab=document.getElementById('tlab');
  const play=document.getElementById('play'),pico=document.getElementById('pico'),ptxt=document.getElementById('ptxt');
  function setLab(){tlab.textContent='ชม. '+Math.round(t*24);}
  function tick(){
    if(playing){t+=floodSpeed;if(t>=1){t=1;playing=false;pico.className='ti ti-player-play';ptxt.textContent='เล่นอีกครั้ง';}
      sld.value=Math.round(t*100);setLab();}
    if(!reduce)dash=(dash+0.7)%14;
    if(!reduce&&playing)particles=particles.map(p=>{p+=0.0015;return p>1?0:p;});
    draw();raf=requestAnimationFrame(tick);
  }
  play.onclick=function(){
    if(t>=1){t=0;}
    playing=!playing;
    pico.className=playing?'ti ti-player-pause':'ti ti-player-play';
    ptxt.textContent=playing?'หยุด':(t>0?'เล่นต่อ':'เล่น');
  };
  sld.oninput=function(){playing=false;pico.className='ti ti-player-play';ptxt.textContent='เล่นต่อ';t=sld.value/100;setLab();};
  setLab();raf=requestAnimationFrame(tick);

  const fetchMockBtn=document.getElementById('fetchMockBtn');
  const fetchStatus=document.getElementById('fetchStatus');
  const fetchDataDisplay=document.getElementById('fetchDataDisplay');
  const damRate=document.getElementById('damRate');
  const riverLevel=document.getElementById('riverLevel');
  
  if (fetchMockBtn) {
    fetchMockBtn.onclick=function(){
      fetchMockBtn.disabled=true;
      fetchMockBtn.style.opacity='0.6';
      fetchMockBtn.innerHTML='<i class="ti ti-loader" style="font-size:16px;"></i>กำลังเชื่อมต่อ...';
      fetchStatus.textContent='สถานะ: กำลังดึงข้อมูลจาก API...';
      
      setTimeout(()=>{
        damRate.textContent='450'; 
        riverLevel.textContent='18.45';
        
        fetchDataDisplay.style.display='grid';
        fetchStatus.innerHTML='สถานะ: <span class="text-danger">เตือนภัยวิกฤต! ปริมาณน้ำเข้าเมืองสูง</span>';
        
        floodSpeed = 0.0090; 
        floodDepth = 0.65;   
        
        fetchMockBtn.innerHTML='<i class="ti ti-check" style="font-size:16px;"></i>อัปเดตโมเดลแล้ว';
        
        if(!playing){
          play.click();
        }
      }, 1500);
    };
  }
})();
