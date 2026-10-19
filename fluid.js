/* Hiệu ứng "mực loang" theo chuột bằng mô phỏng chất lỏng (WebGL2) — giống kiểu Splash Cursor của mẫu.
   Các bước mỗi khung hình: xoáy (curl/vorticity) → độ phân kỳ → áp suất → trừ gradient → cuốn trôi vận tốc & màu.
   Màu được hiển thị trong suốt trên nền trắng (vùng có mực mới có màu).
   Dùng: initFluid(canvas, { colors: [[r,g,b], ...] }) → trả về false nếu trình duyệt không hỗ trợ. */
function initFluid(canvas, opts = {}) {
  const CFG = Object.assign({
    SIM_RES: 128, DYE_RES: 768,
    DENSITY_DISSIPATION: 3.2, VELOCITY_DISSIPATION: 2,
    PRESSURE: 0.8, PRESSURE_ITER: 20, CURL: 4,
    SPLAT_RADIUS: 0.2, SPLAT_FORCE: 5000, DYE_STRENGTH: 0.16, RAINBOW: false, HUE_SPEED: 0.35, SATURATION: 1,
    colors: [[74, 222, 128], [96, 165, 250], [56, 189, 248]]
  }, opts);

  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) return false;
  if (!gl.getExtension('EXT_color_buffer_float')) return false;
  gl.getExtension('OES_texture_float_linear');
  gl.clearColor(0, 0, 0, 0);

  /* ---------- Shader ---------- */
  const VERT = `#version 300 es
  precision highp float;
  in vec2 aPos; uniform vec2 texel;
  out vec2 vUv, vL, vR, vT, vB;
  void main(){ vUv = aPos*.5+.5; vL = vUv-vec2(texel.x,0.); vR = vUv+vec2(texel.x,0.); vT = vUv+vec2(0.,texel.y); vB = vUv-vec2(0.,texel.y); gl_Position = vec4(aPos,0.,1.); }`;
  const FRAG = body => `#version 300 es
  precision highp float; precision highp sampler2D;
  in vec2 vUv, vL, vR, vT, vB; out vec4 o;
  ${body}`;
  const SRC = {
    clear: FRAG(`uniform sampler2D uTex; uniform float value; void main(){ o = value*texture(uTex,vUv); }`),
    splat: FRAG(`uniform sampler2D uTarget; uniform float aspect, radius; uniform vec3 color; uniform vec2 point;
      void main(){ vec2 p = vUv-point; p.x *= aspect; vec3 s = exp(-dot(p,p)/radius)*color; o = vec4(texture(uTarget,vUv).xyz+s,1.); }`),
    advect: FRAG(`uniform sampler2D uVel, uSrc; uniform vec2 texel; uniform float dt, dissipation;
      void main(){ vec2 c = vUv-dt*texture(uVel,vUv).xy*texel; o = texture(uSrc,c)/(1.+dissipation*dt); }`),
    divergence: FRAG(`uniform sampler2D uVel;
      void main(){ float L=texture(uVel,vL).x, R=texture(uVel,vR).x, T=texture(uVel,vT).y, B=texture(uVel,vB).y; vec2 C=texture(uVel,vUv).xy;
        if(vL.x<0.)L=-C.x; if(vR.x>1.)R=-C.x; if(vT.y>1.)T=-C.y; if(vB.y<0.)B=-C.y; o = vec4(.5*(R-L+T-B),0.,0.,1.); }`),
    curl: FRAG(`uniform sampler2D uVel;
      void main(){ float L=texture(uVel,vL).y, R=texture(uVel,vR).y, T=texture(uVel,vT).x, B=texture(uVel,vB).x; o = vec4(.5*(R-L-T+B),0.,0.,1.); }`),
    vorticity: FRAG(`uniform sampler2D uVel, uCurl; uniform float curl, dt;
      void main(){ float L=texture(uCurl,vL).x, R=texture(uCurl,vR).x, T=texture(uCurl,vT).x, B=texture(uCurl,vB).x, C=texture(uCurl,vUv).x;
        vec2 f = .5*vec2(abs(T)-abs(B), abs(R)-abs(L)); f /= length(f)+.0001; f *= curl*C; f.y *= -1.;
        vec2 v = texture(uVel,vUv).xy+f*dt; o = vec4(clamp(v,-1000.,1000.),0.,1.); }`),
    pressure: FRAG(`uniform sampler2D uP, uDiv;
      void main(){ float L=texture(uP,vL).x, R=texture(uP,vR).x, T=texture(uP,vT).x, B=texture(uP,vB).x; o = vec4((L+R+B+T-texture(uDiv,vUv).x)*.25,0.,0.,1.); }`),
    gradient: FRAG(`uniform sampler2D uP, uVel;
      void main(){ float L=texture(uP,vL).x, R=texture(uP,vR).x, T=texture(uP,vT).x, B=texture(uP,vB).x; vec2 v = texture(uVel,vUv).xy-vec2(R-L,T-B); o = vec4(v,0.,1.); }`),
    // hiển thị: kênh màu mạnh nhất làm độ đậm → nền trắng chỉ nhuộm màu ở chỗ có mực
    display: FRAG(`uniform sampler2D uTex;
      void main(){ vec3 c = texture(uTex,vUv).rgb; float a = clamp(max(c.r,max(c.g,c.b)),0.,1.); o = vec4(c,a); }`)
  };

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const P = {};
  for (const [k, src] of Object.entries(SRC)) {
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, src));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    P[k] = { p, u };
  }

  /* hình chữ nhật phủ màn hình */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(0);
  const blit = target => {
    if (target) { gl.viewport(0, 0, target.w, target.h); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
    else { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  /* ---------- Bộ đệm (framebuffer) ---------- */
  function fbo(w, h) {
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo: f, w, h, tx: 1 / w, ty: 1 / h, bind(unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; } };
  }
  function double(w, h) {
    const d = { read: fbo(w, h), write: fbo(w, h), swap() { [d.read, d.write] = [d.write, d.read]; } };
    d.w = w; d.h = h; d.tx = 1 / w; d.ty = 1 / h; return d;
  }
  function res(r) {
    const a = gl.drawingBufferWidth / gl.drawingBufferHeight, big = Math.round(r * Math.max(a, 1 / a)), small = Math.round(r);
    return a > 1 ? [big, small] : [small, big];
  }
  let dye, vel, div, curl, pres;
  function initBuffers() {
    const [sw, sh] = res(CFG.SIM_RES), [dw, dh] = res(CFG.DYE_RES);
    dye = double(dw, dh); vel = double(sw, sh); div = fbo(sw, sh); curl = fbo(sw, sh); pres = double(sw, sh);
  }
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; initBuffers(); }
  }
  resize();

  /* ---------- Nhỏ mực ---------- */
  function splat(x, y, dx, dy, color) {
    const aspect = canvas.width / canvas.height;
    const radius = CFG.SPLAT_RADIUS / 100 * (aspect > 1 ? aspect : 1);
    gl.useProgram(P.splat.p);
    gl.uniform1i(P.splat.u.uTarget, vel.read.bind(0)); gl.uniform1f(P.splat.u.aspect, aspect);
    gl.uniform2f(P.splat.u.point, x, y); gl.uniform3f(P.splat.u.color, dx, dy, 0); gl.uniform1f(P.splat.u.radius, radius);
    gl.uniform2f(P.splat.u.texel, vel.tx, vel.ty);
    blit(vel.write); vel.swap();
    gl.uniform1i(P.splat.u.uTarget, dye.read.bind(0)); gl.uniform3f(P.splat.u.color, color[0], color[1], color[2]);
    gl.uniform2f(P.splat.u.texel, dye.tx, dye.ty);
    blit(dye.write); dye.swap();
  }
  let colorIdx = 0, colorT = 0, hue = Math.random();
  // chế độ cầu vồng: màu chạy liên tục quanh vòng màu RGB (HSV đủ bão hoà)
  function hsv(h) {
    const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f, m = i % 6;
    return [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][m];
  }
  const pickColor = () => CFG.RAINBOW
    ? hsv(hue).map(v => (1 - CFG.SATURATION * (1 - v)) * CFG.DYE_STRENGTH)   // độ bão hoà thấp → màu pastel
    : CFG.colors[colorIdx % CFG.colors.length].map(v => v / 255 * CFG.DYE_STRENGTH);

  /* ---------- Chuột / chạm ---------- */
  const ptr = { x: 0, y: 0, dx: 0, dy: 0, moved: false, init: false };
  function move(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const x = (cx - r.left) / r.width, y = 1 - (cy - r.top) / r.height;
    if (!ptr.init) { ptr.x = x; ptr.y = y; ptr.init = true; return; }
    const a = canvas.width / canvas.height;
    ptr.dx = (x - ptr.x) * (a < 1 ? a : 1); ptr.dy = (y - ptr.y) / (a > 1 ? a : 1);
    ptr.x = x; ptr.y = y; ptr.moved = Math.abs(ptr.dx) > 0 || Math.abs(ptr.dy) > 0;
  }
  addEventListener('pointermove', e => move(e.clientX, e.clientY), { passive: true });
  addEventListener('touchmove', e => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY); }, { passive: true });
  addEventListener('pointerdown', e => {   // bấm: bung một vệt mực
    move(e.clientX, e.clientY);
    const c = pickColor().map(v => v * 8);
    splat(ptr.x, ptr.y, (Math.random() - .5) * 600, 300 + Math.random() * 300, c);
  }, { passive: true });

  /* ---------- Vòng lặp mô phỏng ---------- */
  function step(dt) {
    gl.disable(gl.BLEND);
    const use = (k, texel) => { gl.useProgram(P[k].p); gl.uniform2f(P[k].u.texel, texel.tx, texel.ty); return P[k].u; };
    let u;
    u = use('curl', vel); gl.uniform1i(u.uVel, vel.read.bind(0)); blit(curl);
    u = use('vorticity', vel); gl.uniform1i(u.uVel, vel.read.bind(0)); gl.uniform1i(u.uCurl, curl.bind(1));
    gl.uniform1f(u.curl, CFG.CURL); gl.uniform1f(u.dt, dt); blit(vel.write); vel.swap();
    u = use('divergence', vel); gl.uniform1i(u.uVel, vel.read.bind(0)); blit(div);
    u = use('clear', pres); gl.uniform1i(u.uTex, pres.read.bind(0)); gl.uniform1f(u.value, CFG.PRESSURE); blit(pres.write); pres.swap();
    u = use('pressure', vel); gl.uniform1i(u.uDiv, div.bind(0));
    for (let i = 0; i < CFG.PRESSURE_ITER; i++) { gl.uniform1i(u.uP, pres.read.bind(1)); blit(pres.write); pres.swap(); }
    u = use('gradient', vel); gl.uniform1i(u.uP, pres.read.bind(0)); gl.uniform1i(u.uVel, vel.read.bind(1)); blit(vel.write); vel.swap();
    u = use('advect', vel); gl.uniform1i(u.uVel, vel.read.bind(0)); gl.uniform1i(u.uSrc, vel.read.bind(0));
    gl.uniform1f(u.dt, dt); gl.uniform1f(u.dissipation, CFG.VELOCITY_DISSIPATION); blit(vel.write); vel.swap();
    gl.uniform1i(u.uVel, vel.read.bind(0)); gl.uniform1i(u.uSrc, dye.read.bind(1));
    gl.uniform1f(u.dissipation, CFG.DENSITY_DISSIPATION); blit(dye.write); dye.swap();
  }
  function render() {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.display.p); gl.uniform2f(P.display.u.texel, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(P.display.u.uTex, dye.read.bind(0)); blit(null);
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 60); last = now;
    resize();
    colorT += dt * 2; if (colorT >= 1) { colorT = 0; colorIdx++; }   // đổi màu mực dần dần
    hue = (hue + dt * CFG.HUE_SPEED) % 1;
    if (ptr.moved) { ptr.moved = false; splat(ptr.x, ptr.y, ptr.dx * CFG.SPLAT_FORCE, ptr.dy * CFG.SPLAT_FORCE, pickColor()); }
    step(dt); render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return true;
}
