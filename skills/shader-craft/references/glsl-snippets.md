# GLSL snippets (WebGL2 / GLSL 3.0 ES compatible)

## Hash & random
```glsl
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p) { p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
```

## Simplex noise 3D (Ashima / Stefan Gustavson, MIT)
```glsl
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
```

## fBm
```glsl
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * snoise(p); p *= 2.02; a *= 0.5; } return s; }
```

## Fresnel (Schlick-style rim)
```glsl
float fresnel(vec3 n, vec3 v, float power) { return pow(1.0 - clamp(dot(normalize(n), normalize(v)), 0.0, 1.0), power); }
// v = normalize(cameraPosition - vWorldPos)
```

## Triplanar sampling (no UVs needed — rocks, terrain, procedural props)
```glsl
vec3 triplanar(sampler2D tex, vec3 p, vec3 n, float scale) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture(tex, p.yz * scale).rgb * w.x + texture(tex, p.xz * scale).rgb * w.y + texture(tex, p.xy * scale).rgb * w.z;
}
```

## Cosine palette (Inigo Quilez)
```glsl
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }
// palette(t, vec3(.5), vec3(.5), vec3(1.), vec3(0., .33, .67))
```

## Remap / rotate
```glsl
float remap(float v, float a, float b, float c, float d) { return c + (v - a) * (d - c) / (b - a); }
mat2 rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
```

## SDF primitives (raymarching / masks)
```glsl
float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdRoundBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
```

## Hologram (fragment, additive, transparent)
```glsl
float scan = 0.5 + 0.5 * sin(vWorldPos.y * 80.0 - uTime * 6.0);
float rim = fresnel(vNormal, viewDir, 2.5);
vec3 col = uColor * (0.25 + 0.75 * rim) * (0.6 + 0.4 * scan);
gl_FragColor = vec4(col * 3.0, rim * 0.9 + 0.1);   // material: transparent, depthWrite false, AdditiveBlending
```

## Vertex wind sway (grass, leaves, cloth edges) — inject after `#include <begin_vertex>`
```glsl
float sway = sin(uTime * 1.7 + position.x * 0.8 + position.z * 0.6) * 0.08;
transformed.x += sway * smoothstep(0.0, 1.0, position.y);   // root stays fixed
```
