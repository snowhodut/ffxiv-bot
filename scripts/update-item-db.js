/**
 * 한국어 아이템 DB 업데이트 스크립트
 * 
 * GitHub의 ffxiv-datamining-ko 레포에서 Item.csv를 다운받아
 * 봇에서 사용할 수 있는 JSON 형식으로 변환합니다.
 * 
 * 사용법: node scripts/update-item-db.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CSV_URL = 'https://raw.githubusercontent.com/Ra-Workspace/ffxiv-datamining-ko/master/csv/Item.csv';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'items_ko.json');

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                // 리다이렉트 처리
                return downloadFile(res.headers.location).then(resolve).catch(reject);
            }
            
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function parseCSV(csvText) {
    // 멀티라인 셀을 고려한 줄 분리
    const lines = splitCSVLines(csvText);
    const items = [];
    
    // CSV 구조 (스크린샷 기준):
    // Row 1: key, 0, 1, 2, ... (컬럼 번호)
    // Row 2: #, Singular, Adjective, ... Description, Name, Icon (컬럼 이름)
    // Row 3: int32, str, sbyte, ... str, str, Image (타입)
    // Row 4+: 데이터
    
    if (lines.length < 4) {
        throw new Error('CSV 파일 형식이 올바르지 않습니다.');
    }
    
    // 컬럼 이름에서 인덱스 찾기 (Row 2)
    const columnNames = parseCSVLine(lines[1]);
    
    let nameIndex = -1;
    let iconIndex = -1;
    
    for (let i = 0; i < columnNames.length; i++) {
        const col = columnNames[i].trim();
        if (col === 'Name') {
            nameIndex = i;
        }
        if (col === 'Icon') {
            iconIndex = i;
        }
    }
    
    // 못 찾으면 기본값 (스크린샷 기준: Name=10, Icon=11)
    if (nameIndex === -1) nameIndex = 10;
    if (iconIndex === -1) iconIndex = 11;
    
    console.log(`Name 컬럼 인덱스: ${nameIndex}, Icon 컬럼 인덱스: ${iconIndex}`);
    
    // 데이터 파싱 (4번째 줄부터, 인덱스 3)
    let errorCount = 0;
    let lastSuccessId = 0;
    
    for (let i = 3; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
            const cols = parseCSVLine(line);
            
            if (cols.length < Math.max(nameIndex, iconIndex) + 1) {
                // 컬럼 수가 부족하면 스킵
                errorCount++;
                continue;
            }
            
            const id = parseInt(cols[0], 10);
            const name = cols[nameIndex] || '';
            const iconId = cols[iconIndex] || '';
            
            // 유효한 아이템만 추가 (이름이 있고, ID가 유효한 경우)
            if (id > 0 && name && name.trim()) {
                const item = {
                    id: id,
                    name: name.trim()
                };
                
                // 아이콘 경로 생성
                if (iconId && iconId !== '0' && !isNaN(parseInt(iconId))) {
                    const iconNum = parseInt(iconId, 10);
                    const paddedId = iconNum.toString().padStart(6, '0');
                    const folder = paddedId.substring(0, 3) + '000';
                    item.icon = `/i/${folder}/${paddedId}.png`;
                }
                
                items.push(item);
                lastSuccessId = id;
            }
        } catch (e) {
            errorCount++;
            // 디버깅용: 에러 발생 위치 출력
            if (errorCount <= 5) {
                console.warn(`경고: 줄 ${i + 1} 파싱 실패 - ${e.message}`);
            }
        }
    }
    
    if (errorCount > 0) {
        console.log(`파싱 중 ${errorCount}개 줄 스킵됨`);
    }
    console.log(`마지막 성공 ID: ${lastSuccessId}`);
    
    return items;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current);
    return result;
}

/**
 * CSV 텍스트를 줄 단위로 분리 (멀티라인 셀 처리)
 */
function splitCSVLines(csvText) {
    const lines = [];
    let currentLine = '';
    let inQuotes = false;
    
    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
            currentLine += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (currentLine.trim()) {
                lines.push(currentLine);
            }
            currentLine = '';
            // \r\n 처리
            if (char === '\r' && csvText[i + 1] === '\n') {
                i++;
            }
        } else {
            currentLine += char;
        }
    }
    
    if (currentLine.trim()) {
        lines.push(currentLine);
    }
    
    return lines;
}

async function main() {
    console.log('한국어 아이템 DB 업데이트 시작...');
    console.log(`소스: ${CSV_URL}`);
    
    try {
        // CSV 다운로드
        console.log('CSV 다운로드 중...');
        const csvText = await downloadFile(CSV_URL);
        console.log(`다운로드 완료: ${csvText.length} bytes`);
        
        // CSV 파싱
        console.log('CSV 파싱 중...');
        const items = parseCSV(csvText);
        console.log(`파싱 완료: ${items.length}개 아이템`);
        
        // JSON 저장
        console.log(`저장 중: ${OUTPUT_PATH}`);
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(items, null, 2), 'utf-8');
        
        console.log('✅ 완료!');
        console.log(`   총 ${items.length}개 아이템이 저장되었습니다.`);
        
        // 샘플 출력
        console.log('\n샘플 데이터:');
        for (let i = 0; i < Math.min(5, items.length); i++) {
            console.log(`   ${items[i].id}: ${items[i].name}`);
        }
        
    } catch (error) {
        console.error('❌ 오류:', error.message);
        process.exit(1);
    }
}

main();