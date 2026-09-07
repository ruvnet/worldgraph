import {defineConfig} from '@playwright/test';
/** Deliberately separate from SwiftShader CI. Requires a graphical desktop. */
export default defineConfig({
 testDir:'./hardware-tests',workers:1,retries:0,timeout:180_000,
 expect:{timeout:30_000},reporter:[['list'],['json',{outputFile:'gpu-results/results.json'}]],
 outputDir:'gpu-results',
 use:{baseURL:'http://127.0.0.1:4173/worldgraph/',headless:false,viewport:{width:1440,height:900},deviceScaleFactor:1,
  trace:'retain-on-failure',screenshot:'only-on-failure'},
 webServer:{command:'npm run preview -- --host 127.0.0.1',url:'http://127.0.0.1:4173/worldgraph/',reuseExistingServer:false,timeout:30_000},
});
