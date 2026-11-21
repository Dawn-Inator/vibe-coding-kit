/* Deep Space Theatre: original procedural scenery, MIT, Vibe Coding Kit.
 * Load vendor/three-r180.js before this file for sculptural WebGL objects.
 * The presenter owns the clock. This module never schedules animation frames.
 */
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const color = value => /^#[\da-f]{6}$/i.test(value || '') ? value : '#91c9c6';
  const rgb = value => [1, 3, 5].map(i => parseInt(color(value).slice(i, i + 2), 16));
  const rgba = (value, alpha) => `rgba(${rgb(value).join(',')},${clamp(alpha)})`;
  const mix = (a, b, p) => a + (b - a) * p;
  const hash = text => Array.from(String(text)).reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  function randomGenerator(seed) {
    let value = (number(seed, 20261121) >>> 0) || 1;
    return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
  }
  const sampleHash = (x, y, seed) => {
    let value = Math.imul(x ^ seed, 374761393) ^ Math.imul(y + seed, 668265263);
    value = Math.imul(value ^ value >>> 13, 1274126177);
    return ((value ^ value >>> 16) >>> 0) / 4294967296;
  };
  function noise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    return mix(mix(sampleHash(ix, iy, seed), sampleHash(ix + 1, iy, seed), fx),
      mix(sampleHash(ix, iy + 1, seed), sampleHash(ix + 1, iy + 1, seed), fx), fy);
  }

  window.createDeepSpaceTheme = function createDeepSpaceTheme(host, options = {}) {
    if (!host || !host.append) throw new TypeError('A theme host element is required.');
    let width = number(options.width, 1600), height = number(options.height, 900);
    const seed = number(options.seed, 20261121) >>> 0;
    const random = randomGenerator(seed);
    const layer = document.createElement('div');
    layer.className = 'deep-space-theme'; layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;background:#070e16;';
    const background = document.createElement('canvas'), sculpture = document.createElement('canvas');
    for (const canvas of [background, sculpture]) {
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      layer.append(canvas);
    }
    host.append(layer);
    const context = background.getContext('2d');
    if (!context) { layer.remove(); throw new Error('Canvas 2D is required for this theme.'); }
    const stars = Array.from({length: 410}, (_, i) => ({
      x: random() * 1.16, y: random(), depth: i < 260 ? .22 : i < 370 ? .56 : 1,
      radius: (.28 + random() * .72) * (i < 260 ? .65 : i < 370 ? 1 : 1.4),
      alpha: .18 + random() * .54, phase: random() * TAU, warm: random() < .19,
    }));

    // A seeded, low-resolution density field is generated once. Color/light are
    // composited separately so chapter transitions do not rebuild a texture.
    const cloud = document.createElement('canvas'); cloud.width = 384; cloud.height = 216;
    const cloudContext = cloud.getContext('2d');
    const field = cloudContext.createImageData(cloud.width, cloud.height);
    for (let y = 0; y < cloud.height; y++) for (let x = 0; x < cloud.width; x++) {
      const u = x / cloud.width, v = y / cloud.height;
      const warp = noise(u * 3.2, v * 3.2, seed);
      let density = 0, amplitude = .57, frequency = 3;
      for (let octave = 0; octave < 5; octave++) {
        density += amplitude * noise(u * frequency + warp * 1.7, v * frequency + warp, seed + octave * 31);
        amplitude *= .48; frequency *= 2.12;
      }
      const diagonal = Math.exp(-((v - (.78 - u * .46)) ** 2) / .11);
      const alpha = clamp((density - .25) * 1.55) ** 2.1 * diagonal;
      const offset = (y * cloud.width + x) * 4;
      field.data[offset] = field.data[offset + 1] = field.data[offset + 2] = 255;
      field.data[offset + 3] = Math.round(alpha * 185);
    }
    cloudContext.putImageData(field, 0, 0);
    const tintedCloud = document.createElement('canvas');
    tintedCloud.width = cloud.width; tintedCloud.height = cloud.height;
    const tintContext = tintedCloud.getContext('2d');
    let cloudColor = '';

    const objects = new Map();
    let renderer = null, scene = null, camera = null, T = null;
    let pixelRatio = 1, paints = 0, disposed = false, contextLost = false, lastState = null;
    let rendererError = '';
    const query = new URLSearchParams(location.search);

    // Geometry is normalized to a sphere radius of one. Perspective is chosen
    // so one world unit equals one authored stage pixel on the z = 0 plane.
    function setupWebGL() {
      if (options.webgl === false || query.get('webgl') === '0') return;
      T = window.TheatreThree;
      if (!T) return;
      try {
        const gl = sculpture.getContext('webgl2', {alpha: true, antialias: true, powerPreference: 'low-power'});
        if (!gl) return;
        renderer = new T.WebGLRenderer({canvas: sculpture, context: gl, alpha: true, antialias: true});
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = T.SRGBColorSpace;
        scene = new T.Scene();
        const fov = 35, distance = height / (2 * Math.tan(fov * Math.PI / 360));
        camera = new T.PerspectiveCamera(fov, width / height, 1, 12000);
        camera.position.set(0, 0, distance); camera.lookAt(0, 0, 0);
      } catch (error) {
        rendererError = String(error.message || error);
        if (renderer) renderer.dispose(); renderer = null;
      }
    }
    setupWebGL();

    const surfaceVertex = `
      varying vec3 localP; varying vec3 normalV; varying vec3 eyeV;
      void main(){localP=position;vec4 point=modelViewMatrix*vec4(position,1.);
        normalV=normalize(normalMatrix*normal);eyeV=-point.xyz;gl_Position=projectionMatrix*point;}`;
    const surfaceFragment = `
      uniform vec3 tint;uniform float reveal;uniform float offset;
      varying vec3 localP;varying vec3 normalV;varying vec3 eyeV;
      float h(vec3 p){return fract(sin(dot(p,vec3(91.7,237.4,163.1)))*43758.5453);}
      float n(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}
      float fb(vec3 p){return .54*n(p)+.27*n(p*2.07)+.13*n(p*4.31)+.06*n(p*8.73);}
      void main(){
        vec3 p=localP;float cloud=fb(p*4.+offset);
        float storm=fb(p*9.+cloud*2.1);
        float belt=.5+.5*sin(p.y*40.+cloud*8.+sin(p.x*7.+p.z*4.)*1.4);
        float narrow=.5+.5*sin(p.y*128.+storm*17.);
        float detail=.48+.36*belt+.16*narrow;
        vec3 litColor=mix(tint*.37,mix(tint,vec3(.95,.88,.75),.22),detail);
        litColor=mix(litColor,vec3(.75,.86,.87),smoothstep(.68,.84,cloud)*.54);
        vec3 N=normalize(normalV),V=normalize(eyeV),L=normalize(vec3(-.72,.63,.82));
        float day=dot(N,L),sun=pow(max(day,0.),.74);
        float rim=pow(1.-max(dot(N,V),0.),3.3);
        vec3 result=litColor*(.055+1.18*sun);
        result+=mix(tint,vec3(.72,.91,1.),.35)*rim*(.08+.45*smoothstep(-.28,.65,day));
        float spec=pow(max(dot(reflect(-L,N),V),0.),18.)*.10;
        result+=vec3(.92,.87,.73)*spec;
        gl_FragColor=vec4(result,reveal);
        #include <colorspace_fragment>
      }`;
    const ringVertex = `varying vec2 radial;void main(){radial=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
    const ringFragment = `
      uniform vec3 tint;uniform float reveal;uniform float phase;varying vec2 radial;
      void main(){float r=length(radial),a=atan(radial.y,radial.x);
        float strata=.56+.20*sin(r*252.)+.14*sin(r*537.);
        float inner=smoothstep(1.20,1.25,r),outer=1.-smoothstep(1.78,1.83,r);
        float gap=smoothstep(.009,.028,abs(r-1.49));
        float glint=pow(max(0.,cos(a-phase)),24.);
        vec3 c=mix(tint,vec3(.89,.80,.61),.58)*(.52+strata*.54)+glint*.21;
        gl_FragColor=vec4(c,reveal*inner*outer*gap*(.23+strata*.59));
        #include <colorspace_fragment>
      }`;

    function makeMesh(geometry, material, group) {
      const mesh = new T.Mesh(geometry, material); group.add(mesh); return mesh;
    }
    function makeObject(data) {
      const group = new T.Group(); scene.add(group);
      const item = {group, kind: data.kind, materials: [], geometries: [], lastUsed: paints, points: [], links: []};
      const keepGeometry = geometry => { item.geometries.push(geometry); return geometry; };
      const keepMaterial = material => { item.materials.push(material); return material; };
      if (data.kind === 'network') {
        const random = randomGenerator(hash(data.id) ^ seed);
        const vertexCount = 27, vertices = [];
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));
        const pointShape = keepGeometry(new T.SphereGeometry(.018, 10, 8));
        const nodeMaterial = keepMaterial(new T.MeshBasicMaterial({color: data.color, transparent: true}));
        const lineMaterial = keepMaterial(new T.LineBasicMaterial({color: data.color, transparent: true, opacity: .35}));
        for (let i = 0; i < vertexCount; i++) {
          const y = 1 - 2 * (i + .5) / vertexCount, r = Math.sqrt(1 - y * y), angle = i * goldenAngle;
          const point = new T.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r).multiplyScalar(.91 + random() * .13);
          vertices.push(point);
          const node = makeMesh(pointShape, nodeMaterial, group); node.position.copy(point); item.points.push(node);
        }
        for (let i = 0; i < vertices.length; i++) for (let j = 0; j < i; j++) {
          if (vertices[i].distanceTo(vertices[j]) > .74) continue;
          const geometry = keepGeometry(new T.BufferGeometry().setFromPoints([vertices[i], vertices[j]]));
          group.add(new T.Line(geometry, lineMaterial)); item.links.push([vertices[i], vertices[j]]);
        }
        const signalMaterial = keepMaterial(new T.MeshBasicMaterial({color: '#fff1ca', transparent: true}));
        signalMaterial.userData.fixedColor = true;
        item.signal = makeMesh(keepGeometry(new T.SphereGeometry(.027, 12, 8)), signalMaterial, group);
        const orbitMaterial = keepMaterial(new T.MeshBasicMaterial({color: data.color, transparent: true, opacity: .24}));
        item.orbit = makeMesh(keepGeometry(new T.TorusGeometry(1.22, .002, 5, 144)), orbitMaterial, group);
        item.orbit.rotation.set(.42, -.18, -.27);
      } else {
        const surface = keepMaterial(new T.ShaderMaterial({
          uniforms: {tint: {value: new T.Color(data.color)}, reveal: {value: 1}, offset: {value: (hash(data.id) % 127) / 31}},
          vertexShader: surfaceVertex, fragmentShader: surfaceFragment, transparent: true,
        }));
        item.sphere = makeMesh(keepGeometry(new T.SphereGeometry(1, 80, 56)), surface, group);
        item.sphere.rotation.z = -.19;
        if (data.kind === 'ring') {
          const ring = keepMaterial(new T.ShaderMaterial({uniforms: {
            tint: {value: new T.Color(data.color)}, reveal: {value: 1}, phase: {value: 0},
          }, vertexShader: ringVertex, fragmentShader: ringFragment, transparent: true, side: T.DoubleSide, depthWrite: false}));
          item.ring = makeMesh(keepGeometry(new T.RingGeometry(1.20, 1.83, 224, 1)), ring, group);
          item.ring.rotation.set(1.14, -.22, -.25);
          // Fine orbiting points are authored from a seeded distribution.
          const random = randomGenerator(hash(data.id) ^ seed);
          const positions = [];
          for (let i = 0; i < 116; i++) {
            const angle = random() * TAU, radius = 1.27 + random() * .46;
            positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, (random() - .5) * .009);
          }
          const geometry = keepGeometry(new T.BufferGeometry());
          geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
          const material = keepMaterial(new T.PointsMaterial({color: '#f7ddac', size: 1.7, sizeAttenuation: false,
            transparent: true, opacity: .6, depthWrite: false}));
          material.userData.fixedColor = true;
          item.dust = new T.Points(geometry, material); item.ring.add(item.dust);
        }
      }
      return item;
    }
    function disposeObject(item) {
      item.group.removeFromParent();
      item.geometries.forEach(geometry => geometry.dispose());
      item.materials.forEach(material => material.dispose());
    }
    function normalizeState(input = {}) {
      return {
        timeMs: Math.max(0, number(input.timeMs)),
        light: [clamp(number(input.light?.[0], .76)), clamp(number(input.light?.[1], .38))],
        tint: color(input.tint), level: clamp(number(input.level, .65)), cameraX: number(input.cameraX),
        objects: (Array.isArray(input.objects) ? input.objects : []).map((object, index) => ({
          id: String(object.id ?? `object-${index}`), kind: ['planet', 'ring', 'network'].includes(object.kind) ? object.kind : 'planet',
          x: number(object.x, width * .75), y: number(object.y, height * .5),
          radius: Math.max(1, number(object.radius, 180)), rotation: number(object.rotation),
          reveal: clamp(number(object.reveal, 1)), color: color(object.color || input.tint),
        })),
      };
    }

    function glow(x, y, radius, tint, alpha) {
      const gradient = context.createRadialGradient(x, y, 0, x, y, Math.max(1, radius));
      gradient.addColorStop(0, rgba(tint, alpha)); gradient.addColorStop(.36, rgba(tint, alpha * .28));
      gradient.addColorStop(1, rgba(tint, 0));
      context.fillStyle = gradient; context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    function drawSky(state) {
      const seconds = state.timeMs / 1000;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
      const base = context.createLinearGradient(0, 0, width, height);
      base.addColorStop(0, '#080f18'); base.addColorStop(.55, '#101923'); base.addColorStop(1, '#070d14');
      context.fillStyle = base; context.fillRect(0, 0, width, height);
      const lx = state.light[0] * width, ly = state.light[1] * height;
      glow(lx, ly, width * .56, state.tint, state.level * .23);
      glow(lx - width * .12, ly - height * .16, width * .38, '#d9a36c', state.level * .085);
      if (cloudColor !== state.tint) {
        tintContext.globalCompositeOperation = 'source-over'; tintContext.clearRect(0, 0, cloud.width, cloud.height);
        tintContext.drawImage(cloud, 0, 0); tintContext.globalCompositeOperation = 'source-in';
        tintContext.fillStyle = state.tint; tintContext.fillRect(0, 0, cloud.width, cloud.height);
        cloudColor = state.tint;
      }
      context.save(); context.globalCompositeOperation = 'screen'; context.globalAlpha = state.level * .42;
      const drift = Math.sin(seconds * .009) * 16 - state.cameraX * .08;
      context.drawImage(tintedCloud, -width * .08 + drift, -height * .11, width * 1.19, height * 1.21);
      context.globalAlpha = state.level * .10;
      context.drawImage(tintedCloud, width * .09 - drift, height * .06, width * .98, height * .91);
      context.restore();

      // Quiet, almost invisible orbit lines unify the stage without boxing it.
      context.save(); context.lineWidth = .65;
      context.strokeStyle = rgba(state.tint, .075 + state.level * .04);
      for (const [x, y, rx, ry, rotation] of [[.59, .46, .70, .28, -.13], [.48, .56, .61, .22, .16]]) {
        context.beginPath(); context.ellipse(width * x - state.cameraX * .04, height * y, width * rx, height * ry, rotation, 0, TAU); context.stroke();
      }
      for (const star of stars) {
        const span = width * 1.16;
        const raw = star.x * width - state.cameraX * star.depth - seconds * 1.35 * star.depth;
        const x = ((raw + width * .08) % span + span) % span - width * .08;
        const twinkle = .77 + .23 * Math.sin(seconds * (.4 + star.depth * .36) + star.phase);
        const alpha = star.alpha * twinkle * (.46 + state.level * .54);
        context.fillStyle = rgba(star.warm ? '#e8cda5' : '#c6dce5', alpha);
        context.beginPath(); context.arc(x, star.y * height, star.radius, 0, TAU); context.fill();
        if (star.radius > 1.03) {
          context.strokeStyle = rgba('#d5e8ed', alpha * .25); context.lineWidth = .5;
          context.beginPath(); context.moveTo(x - 3.5, star.y * height); context.lineTo(x + 3.5, star.y * height);
          context.moveTo(x, star.y * height - 3.5); context.lineTo(x, star.y * height + 3.5); context.stroke();
        }
      }
      context.restore();
      const vignette = context.createRadialGradient(width * .55, height * .48, width * .17, width * .55, height * .48, width * .77);
      vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,3,9,.58)');
      context.fillStyle = vignette; context.fillRect(0, 0, width, height);
    }

    function drawFallbackRing(object, front) {
      const r = object.radius, stateAlpha = object.reveal;
      context.save(); context.translate(object.x, object.y); context.rotate(-.31);
      for (let band = 0; band < 24; band++) {
        const radius = r * (1.24 + band * .023);
        if (band > 9 && band < 12) continue;
        context.strokeStyle = rgba(band % 5 ? '#b4a58a' : '#f4dfb0', stateAlpha * (.16 + .17 * (band % 3) / 2));
        context.lineWidth = Math.max(.5, r * .004);
        context.beginPath(); context.ellipse(0, 0, radius, radius * .37, 0, front ? 0 : Math.PI, front ? Math.PI : TAU); context.stroke();
      }
      const angle = object.rotation * .63;
      const y = Math.sin(angle) * r * 1.57 * .37;
      if ((front && y >= 0) || (!front && y < 0)) {
        const x = Math.cos(angle) * r * 1.57;
        context.fillStyle = rgba('#fff0c9', stateAlpha * .85);
        context.beginPath(); context.arc(x, y, 2.2, 0, TAU); context.fill();
      }
      context.restore();
    }
    function drawFallbackPlanet(object) {
      const r = object.radius;
      context.save(); context.globalAlpha = object.reveal;
      context.beginPath(); context.arc(object.x, object.y, r, 0, TAU); context.clip();
      const shade = context.createRadialGradient(object.x - r * .44, object.y - r * .44, r * .06,
        object.x + r * .17, object.y + r * .12, r * 1.21);
      shade.addColorStop(0, '#d5d9c7'); shade.addColorStop(.21, object.color);
      shade.addColorStop(.56, rgba(object.color, .76)); shade.addColorStop(.86, '#10212c'); shade.addColorStop(1, '#050b13');
      context.fillStyle = shade; context.fillRect(object.x - r, object.y - r, r * 2, r * 2);
      context.translate(object.x, object.y); context.rotate(-.16);
      for (let band = -28; band <= 28; band++) {
        const y = band * r / 28;
        context.lineWidth = r * (.007 + .006 * (Math.sin(band * 2.37) + 1));
        context.strokeStyle = band % 3 ? `rgba(3,12,22,${.11 + .09 * (Math.sin(band * 1.4) + 1)})` : 'rgba(233,221,183,.14)';
        context.beginPath();
        for (let x = -r; x <= r; x += r / 32) {
          const warp = Math.sin(x / r * 5.3 + band * .47 + object.rotation) * r * .016
            + Math.cos(x / r * 13 + band * .8) * r * .008;
          if (x === -r) context.moveTo(x, y + warp); else context.lineTo(x, y + warp);
        }
        context.stroke();
      }
      // The terminator belongs above the cloud belts, preserving depth.
      const night = context.createLinearGradient(-r, -r * .3, r, r * .1);
      night.addColorStop(0, 'rgba(0,4,12,0)'); night.addColorStop(.47, 'rgba(0,4,12,.02)');
      night.addColorStop(.76, 'rgba(0,4,12,.48)'); night.addColorStop(1, 'rgba(0,4,12,.92)');
      context.fillStyle = night; context.fillRect(-r, -r, r * 2, r * 2); context.restore();
      context.save(); context.globalAlpha = object.reveal;
      context.strokeStyle = rgba(object.color, .54); context.lineWidth = Math.max(.8, r * .007);
      context.beginPath(); context.arc(object.x, object.y, r * 1.007, Math.PI * 1.02, Math.PI * 1.72); context.stroke(); context.restore();
    }
    function drawFallbackNetwork(object) {
      const vertices = [], goldenAngle = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < 27; i++) {
        const y = 1 - 2 * (i + .5) / 27, r = Math.sqrt(1 - y * y), a = i * goldenAngle + object.rotation;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        vertices.push({x, y, z, px: object.x + x * object.radius, py: object.y + (y * .95 + z * .15) * object.radius});
      }
      context.save(); context.globalAlpha = object.reveal;
      for (let i = 0; i < vertices.length; i++) for (let j = 0; j < i; j++) {
        const a = vertices[i], b = vertices[j];
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > .77) continue;
        context.strokeStyle = rgba(object.color, .15 + (a.z + b.z + 2) * .09); context.lineWidth = .9;
        context.beginPath(); context.moveTo(a.px, a.py); context.lineTo(b.px, b.py); context.stroke();
      }
      for (const point of vertices) {
        context.fillStyle = rgba(point.z > .4 ? '#f1e4bd' : object.color, .4 + (point.z + 1) * .27);
        context.beginPath(); context.arc(point.px, point.py, 1.7 + (point.z + 1) * .8, 0, TAU); context.fill();
      }
      context.strokeStyle = rgba(object.color, .33); context.lineWidth = .8;
      context.beginPath(); context.ellipse(object.x, object.y, object.radius * 1.21, object.radius * .45, -.25, 0, TAU); context.stroke();
      context.restore();
    }
    function drawFallback(state) {
      for (const object of state.objects) {
        if (object.reveal <= 0) continue;
        glow(object.x, object.y, object.radius * 1.65, object.color, object.reveal * .12);
        if (object.kind === 'network') drawFallbackNetwork(object);
        else {
          if (object.kind === 'ring') drawFallbackRing(object, false);
          drawFallbackPlanet(object);
          if (object.kind === 'ring') drawFallbackRing(object, true);
        }
      }
    }
    function drawObjects(state) {
      for (const item of objects.values()) item.group.visible = false;
      for (const data of state.objects) {
        if (data.reveal <= 0) continue;
        // A shared identity may change kind at a chapter boundary. Cache the
        // two forms separately without changing the identity that seeds art.
        const cacheKey = `${data.kind}|${data.id}`;
        let item = objects.get(cacheKey);
        if (!item) { item = makeObject(data); objects.set(cacheKey, item); }
        item.lastUsed = paints; item.group.visible = true;
        item.group.position.set(data.x - width / 2, height / 2 - data.y, 0);
        item.group.scale.setScalar(data.radius);
        item.group.rotation.set(-.09, data.rotation * .17, -.10);
        for (const material of item.materials) {
          if (material.uniforms?.tint) material.uniforms.tint.value.set(data.color);
          if (material.uniforms?.reveal) material.uniforms.reveal.value = data.reveal;
          if (material.color && !material.userData.fixedColor) material.color.set(data.color);
          // Non-shader material base opacities are saved once, then multiplied.
          if (!material.uniforms) {
            if (material.userData.baseOpacity === undefined) material.userData.baseOpacity = material.opacity;
            material.opacity = material.userData.baseOpacity * data.reveal;
          }
        }
        if (item.sphere) item.sphere.rotation.y = data.rotation;
        if (item.ring) {
          item.ring.rotation.set(1.14 + Math.sin(data.rotation * .3) * .025, -.22, -.25);
          item.ring.material.uniforms.phase.value = data.rotation * .7;
          item.dust.rotation.z = -data.rotation * .21;
        }
        if (item.kind === 'network') {
          item.group.rotation.set(-.13, data.rotation, -.12);
          const route = item.links[Math.floor(Math.abs(data.rotation) * 2) % item.links.length];
          if (route) item.signal.position.copy(route[0]).lerp(route[1], ((data.rotation * 2) % 1 + 1) % 1);
        }
      }
      // Bound caches when adapting a long deck with many independent scene IDs.
      if (objects.size > 24) for (const [id, item] of objects) {
        if (!item.group.visible) { disposeObject(item); objects.delete(id); }
        if (objects.size <= 24) break;
      }
      renderer.render(scene, camera);
    }

    function render(input) {
      if (disposed) return;
      const state = normalizeState(input); lastState = state; paints++;
      drawSky(state);
      const usingWebGL = renderer && !contextLost;
      sculpture.hidden = !usingWebGL;
      if (usingWebGL) {
        for (const object of state.objects) if (object.reveal > 0)
          glow(object.x, object.y, object.radius * 1.7, object.color, object.reveal * .10);
        try { drawObjects(state); }
        catch (error) {
          rendererError = String(error.message || error); contextLost = true; sculpture.hidden = true; drawFallback(state);
        }
      } else drawFallback(state);
    }
    function resize(next = {}) {
      if (disposed) return;
      width = Math.max(1, number(next.width, width)); height = Math.max(1, number(next.height, height));
      const displayWidth = host.getBoundingClientRect().width || width;
      pixelRatio = clamp((window.devicePixelRatio || 1) * displayWidth / width, .5, 2);
      background.width = Math.round(width * pixelRatio); background.height = Math.round(height * pixelRatio);
      if (renderer) {
        renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.position.z = height / (2 * Math.tan(camera.fov * Math.PI / 360));
        camera.updateProjectionMatrix();
      }
      if (lastState) render(lastState);
    }
    function lost(event) {
      event.preventDefault(); contextLost = true; sculpture.hidden = true;
      if (lastState) render(lastState);
    }
    function restored() {
      if (disposed || !renderer) return;
      contextLost = false; rendererError = ''; resize();
    }
    sculpture.addEventListener('webglcontextlost', lost);
    sculpture.addEventListener('webglcontextrestored', restored);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    observer?.observe(host);
    window.addEventListener('resize', resize);
    resize();
    function dispose() {
      if (disposed) return;
      disposed = true; observer?.disconnect(); window.removeEventListener('resize', resize);
      sculpture.removeEventListener('webglcontextlost', lost); sculpture.removeEventListener('webglcontextrestored', restored);
      for (const item of objects.values()) disposeObject(item);
      objects.clear(); renderer?.dispose(); layer.remove();
    }
    return {render, resize, dispose, getState: () => ({
      renderer: renderer && !contextLost ? 'webgl' : 'canvas', webgl: Boolean(renderer && !contextLost),
      objectCount: lastState?.objects.length || 0, cachedObjects: objects.size, stars: stars.length,
      paints, running: false, width, height, pixelRatio, contextLost, disposed, error: rendererError,
    })};
  };
})();
