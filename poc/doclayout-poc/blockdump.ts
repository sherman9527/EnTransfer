import path from 'node:path'
import { captureFlow } from '../../electron/pdf/capture/flow'
async function main(){
  const pdf=path.resolve('Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
  const {blocks}=await captureFlow(pdf,{pageLimit:60})
  for(const b of blocks){
    if(b.page<55||b.page>58) continue
    if(b.type==='image') console.log(`p${b.page} IMAGE ${b.imagePixelWidth}x${b.imagePixelHeight} ${b.imageFormat} ${(b.imageData?.length/1024).toFixed(0)}KB`)
    else console.log(`p${b.page} ${b.type} "${(b.text??'').slice(0,50)}"`)
  }
}
main().catch(e=>{console.error(e);process.exit(1)})
