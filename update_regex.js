const fs = require('fs');
const path = require('path');

function processDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory() && !fullPath.includes('.git')) {
            processDirectory(fullPath);
        } else if (stat.isFile() && fullPath.endsWith('.js')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            let originalContent = content;
            
            content = content.replace(/\.replace\(\/\\\.csv\$\/i,/g, '.replace(/\\.(xlsx|csv|xls|json)$/i,');
            content = content.replace(/\.replace\(\/\\\.xlsx\$\/i,/g, '.replace(/\\.(xlsx|csv|xls|json)$/i,');
            content = content.replace(/\.replace\(\/\\\.json\$\/i,/g, '.replace(/\\.(xlsx|csv|xls|json)$/i,');
            content = content.replace(/\.replace\(\/\\\.\(xlsx\|csv\|zip\)\$\/i,/g, '.replace(/\\.(xlsx|csv|xls|json|zip)$/i,');
            content = content.replace(/\.replace\(\/\\\.xlsx\$\|\\\.csv\$\/i,/g, '.replace(/\\.(xlsx|csv|xls|json)$/i,');

            if (content !== originalContent) {
                fs.writeFileSync(fullPath, content, 'utf8');
                console.log(`Updated: ${fullPath}`);
            }
        }
    }
}

processDirectory('.');
console.log("Done");