const fs = require('fs');
const path = require('path');

const dir = 'C:/Users/WETCOM/Desktop/Script Operaciones/Ops Operativo/vsphere';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

files.forEach(file => {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find } else { \n const description = `Se encontraron ... and everything down to return { status: 'SUCCESS' }; \n  }
  const regex = /\s*\}\s*else\s*\{\s*const description = `Se encontraron[\s\S]*?return \{ status: 'SUCCESS' \};\s*\}/g;
  
  if (regex.test(content)) {
    content = content.replace(regex, '');
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Fixed ' + file);
  }
});
