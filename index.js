require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 한국 서버 정보 (이모지 포함)
const KOREAN_SERVERS = [
    { id: 2075, name: '카벙클', emoji: '💎' },
    { id: 2076, name: '초코보', emoji: '🐤' },
    { id: 2077, name: '모그리', emoji: '🧸' },
    { id: 2078, name: '톤베리', emoji: '🗡️' },
    { id: 2080, name: '펜리르', emoji: '🐺' }
];

// 한국어 아이템 데이터베이스 (메모리에 로드)
let koreanItemDB = new Map(); // name -> { id, name, icon }

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

/**
 * 한국어 아이템 DB 로드
 * data/items_ko.json 파일에서 로드
 * 
 * 파일 형식:
 * [
 *   { "id": 17534, "name": "염료: 순백색", "icon": "/i/025000/025847.png" },
 *   ...
 * ]
 * 
 * 이 파일은 https://github.com/Ra-Workspace/ffxiv-datamining-ko 의
 * csv/Item.csv를 파싱해서 만들어야 함
 */
function loadKoreanItemDB() {
    const dbPath = path.join(__dirname, 'data', 'items_ko.json');
    
    if (!fs.existsSync(dbPath)) {
        console.warn('⚠️ 한국어 아이템 DB 파일이 없습니다: data/items_ko.json');
        console.warn('   한국어 검색 기능이 비활성화됩니다.');
        console.warn('   DB 생성 방법: npm run update-db');
        return;
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        for (const item of data) {
            // 이름으로 검색할 수 있도록 Map에 저장
            koreanItemDB.set(item.name.toLowerCase(), item);
        }
        console.log(`✅ 한국어 아이템 DB 로드 완료: ${koreanItemDB.size}개 아이템`);
    } catch (error) {
        console.error('한국어 아이템 DB 로드 실패:', error.message);
    }
}

/**
 * 한국어 아이템 이름으로 검색
 * 부분 일치 검색 지원
 * 
 * 우선순위:
 * 1. 정확히 일치
 * 2. 검색어로 끝나는 것 (짧은 이름 > 낮은 ID)
 * 3. 검색어로 시작하는 것 (짧은 이름 > 낮은 ID)
 * 4. 검색어를 포함하는 것 (짧은 이름 > 낮은 ID)
 * 
 * @returns {{ item: object|null, suggestions: object[] }}
 */
function searchKoreanItem(query) {
    const queryLower = query.toLowerCase();
    
    // 1. 정확히 일치하는 것 먼저
    if (koreanItemDB.has(queryLower)) {
        return { 
            item: koreanItemDB.get(queryLower), 
            suggestions: [] 
        };
    }
    
    const endsWithMatches = [];   // 검색어로 끝나는 것
    const startsWithMatches = []; // 검색어로 시작하는 것
    const containsMatches = [];   // 검색어를 포함하는 것
    
    for (const [name, item] of koreanItemDB) {
        if (name.endsWith(queryLower)) {
            endsWithMatches.push(item);
        } else if (name.startsWith(queryLower)) {
            startsWithMatches.push(item);
        } else if (name.includes(queryLower)) {
            containsMatches.push(item);
        }
    }
    
    // 정렬 함수: 이름 길이순, 같으면 ID 낮은 순
    const sortFn = (a, b) => {
        if (a.name.length !== b.name.length) {
            return a.name.length - b.name.length;
        }
        return a.id - b.id;
    };
    
    endsWithMatches.sort(sortFn);
    startsWithMatches.sort(sortFn);
    containsMatches.sort(sortFn);
    
    // 모든 매치 합치기 (우선순위 순서대로)
    const allMatches = [...endsWithMatches, ...startsWithMatches, ...containsMatches];
    
    if (allMatches.length === 0) {
        return { item: null, suggestions: [] };
    }
    
    // 첫 번째가 메인 결과, 나머지는 추천 (최대 10개)
    const item = allMatches[0];
    const suggestions = allMatches.slice(1, 11);
    
    return { item, suggestions };
}

/**
 * XIVAPI를 통해 영어 아이템 이름으로 검색 (fallback)
 */
async function searchItemByNameEN(itemName) {
    try {
        const url = `https://xivapi.com/api/search?sheets=Item&query=Name~"${encodeURIComponent(itemName)}"&fields=Name,Icon&limit=10`;
        const response = await axios.get(url, { timeout: 10000 });
        
        if (response.data.results && response.data.results.length > 0) {
            const result = response.data.results[0];
            return { 
                id: result.row_id, 
                name: result.fields.Name,
                icon: result.fields.Icon?.path_hr1 || null
            };
        }
        return null;
    } catch (error) {
        console.error('XIVAPI 검색 오류:', error.message);
        return null;
    }
}

/**
 * Universalis API를 통해 특정 서버의 아이템 시세 조회
 */
async function getMarketData(serverId, itemId) {
    try {
        // entries=5로 최근 거래 내역도 가져옴
        const url = `https://universalis.app/api/v2/${serverId}/${itemId}?entries=5`;
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (error) {
        if (error.response?.status === 404) {
            return { hasData: false, listings: [], recentHistory: [] };
        }
        throw error;
    }
}

/**
 * 모든 한국 서버의 시세를 한번에 조회 (Korea 데이터센터 사용)
 */
async function getAllKoreanServerPrices(itemId) {
    try {
        // Korea 데이터센터로 한번에 조회
        const url = `https://universalis.app/api/v2/Korea/${itemId}?entries=10`;
        const response = await axios.get(url, { timeout: 15000 });
        const data = response.data;
        
        const results = [];
        
        // 서버별로 최저가 계산
        for (const server of KOREAN_SERVERS) {
            const serverListings = (data.listings || []).filter(l => l.worldID === server.id);
            
            let minPriceNQ = null;
            let minPriceHQ = null;
            let listingCount = serverListings.length;
            
            if (serverListings.length > 0) {
                const nqListings = serverListings.filter(l => !l.hq);
                const hqListings = serverListings.filter(l => l.hq);
                
                if (nqListings.length > 0) {
                    minPriceNQ = Math.min(...nqListings.map(l => l.pricePerUnit));
                }
                if (hqListings.length > 0) {
                    minPriceHQ = Math.min(...hqListings.map(l => l.pricePerUnit));
                }
            }
            
            // 서버별 업데이트 시간
            const worldUploadTime = data.worldUploadTimes?.[server.id] || null;
            
            results.push({
                server: server.name,
                serverId: server.id,
                emoji: server.emoji,
                hasData: listingCount > 0,
                listingCount,
                minPriceNQ,
                minPriceHQ,
                lastUploadTime: worldUploadTime
            });
        }
        
        // 전체 서버 최근 거래 내역에서 최저가
        let recentTradeMinNQ = null;
        let recentTradeMinHQ = null;
        
        if (data.recentHistory && data.recentHistory.length > 0) {
            const nqHistory = data.recentHistory.filter(h => !h.hq);
            const hqHistory = data.recentHistory.filter(h => h.hq);
            
            if (nqHistory.length > 0) {
                recentTradeMinNQ = Math.min(...nqHistory.map(h => h.pricePerUnit));
            }
            if (hqHistory.length > 0) {
                recentTradeMinHQ = Math.min(...hqHistory.map(h => h.pricePerUnit));
            }
        }
        
        return {
            servers: results,
            recentTradeMinNQ,
            recentTradeMinHQ,
            dcName: data.dcName || 'Korea'
        };
        
    } catch (error) {
        // 데이터센터 조회 실패시 개별 서버 조회로 fallback
        console.error('Korea DC 조회 실패, 개별 서버 조회 시도:', error.message);
        return await getAllKoreanServerPricesFallback(itemId);
    }
}

/**
 * 개별 서버 조회 (fallback)
 */
async function getAllKoreanServerPricesFallback(itemId) {
    const results = [];
    
    for (const server of KOREAN_SERVERS) {
        try {
            const data = await getMarketData(server.id, itemId);
            
            let minPriceNQ = null;
            let minPriceHQ = null;
            let listingCount = 0;
            
            if (data.listings && data.listings.length > 0) {
                listingCount = data.listings.length;
                
                const nqListings = data.listings.filter(l => !l.hq);
                const hqListings = data.listings.filter(l => l.hq);
                
                if (nqListings.length > 0) {
                    minPriceNQ = Math.min(...nqListings.map(l => l.pricePerUnit));
                }
                if (hqListings.length > 0) {
                    minPriceHQ = Math.min(...hqListings.map(l => l.pricePerUnit));
                }
            }
            
            results.push({
                server: server.name,
                serverId: server.id,
                emoji: server.emoji,
                hasData: data.hasData,
                listingCount,
                minPriceNQ,
                minPriceHQ,
                lastUploadTime: data.lastUploadTime
            });
        } catch (error) {
            results.push({
                server: server.name,
                serverId: server.id,
                emoji: server.emoji,
                error: error.message
            });
        }
    }
    
    return {
        servers: results,
        recentTradeMinNQ: null,
        recentTradeMinHQ: null,
        dcName: 'Korea'
    };
}

/**
 * 결과를 Discord Embed로 포맷팅 (스크린샷 형식)
 */
function createResultEmbed(itemName, itemId, data, iconUrl = null) {
    const { servers, recentTradeMinNQ, recentTradeMinHQ } = data;
    
    const embed = new EmbedBuilder()
        .setColor(0x9B59B6) // 보라색
        .setTitle(`${itemName}`)
        .setTimestamp();
    
    // 아이콘 썸네일 추가
    if (iconUrl) {
        embed.setThumbnail(iconUrl);
    }
    
    // NQ 데이터가 있는 서버들
    const serversWithNQ = servers.filter(r => !r.error && r.minPriceNQ !== null);
    const serversWithHQ = servers.filter(r => !r.error && r.minPriceHQ !== null);
    
    // 전체 NQ 최저가 찾기
    let overallMinNQ = null;
    for (const r of serversWithNQ) {
        if (overallMinNQ === null || r.minPriceNQ < overallMinNQ) {
            overallMinNQ = r.minPriceNQ;
        }
    }
    
    // 전체 HQ 최저가 찾기
    let overallMinHQ = null;
    for (const r of serversWithHQ) {
        if (overallMinHQ === null || r.minPriceHQ < overallMinHQ) {
            overallMinHQ = r.minPriceHQ;
        }
    }
    
    // 서버별 가격 목록
    let priceText = '';
    for (let i = 0; i < servers.length; i++) {
        const r = servers[i];
        
        if (r.error) {
            priceText += `${r.emoji} **${r.server}**: ⚠️ 조회 실패`;
        } else {
            // 이 서버가 최저가인지 표시
            const isMinNQ = r.minPriceNQ === overallMinNQ && overallMinNQ !== null;
            const isMinHQ = r.minPriceHQ === overallMinHQ && overallMinHQ !== null;
            const isMin = isMinNQ || isMinHQ;
            
            priceText += `${r.emoji} **${r.server}**\n`;
            
            // 가격 정보
            if (r.minPriceNQ !== null || r.minPriceHQ !== null) {
                const prices = [];
                if (r.minPriceNQ !== null) {
                    prices.push(`NQ 최저 판매가: ${r.minPriceNQ.toLocaleString()} 길`);
                }
                if (r.minPriceHQ !== null) {
                    prices.push(`HQ 최저 판매가: ${r.minPriceHQ.toLocaleString()} 길`);
                }
                
                priceText += `${isMin ? '⭐ ' : ''}${prices.join('\n')}`;
            } else {
                priceText += `매물 없음`;
            }
        }
        
        // 서버들 사이에 줄바꿈 추가 (마지막 서버 제외)
        if (i < servers.length - 1) {
            priceText += '\n\n';
        }
    }
    
    if (priceText) {
        embed.setDescription(priceText);
    }
    
    // 구분선 + 서버 통합 최근 거래 최저가
    if (recentTradeMinNQ !== null || recentTradeMinHQ !== null) {
        let recentText = '\n‧˚₊‧ ┈┈┈ ⟡ ┈┈┈ ‧₊˚⊹\n\n';
        recentText += '📈 **(서버 통합) 최근 거래 최저가**\n';
        
        if (recentTradeMinNQ !== null) {
            recentText += `NQ: ${recentTradeMinNQ.toLocaleString()}G`;
        }
        if (recentTradeMinHQ !== null) {
            if (recentTradeMinNQ !== null) recentText += ' | ';
            recentText += `HQ: ${recentTradeMinHQ.toLocaleString()}G`;
        }
        
        embed.addFields({ name: '\u200B', value: recentText });
    }
    
    // 데이터가 전혀 없는 경우
    if (serversWithNQ.length === 0 && serversWithHQ.length === 0) {
        embed.setColor(0xFF0000);
        embed.setDescription('한국 서버에 등록된 시세 정보가 없습니다.');
    }
    
    return embed;
}

// 봇 시작 시 한국어 DB 로드
client.once('ready', () => {
    console.log(`${client.user.tag} 로그인 성공!`);
    loadKoreanItemDB();
});

// 메시지 이벤트 핸들러
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    // !시세 [아이템이름] 명령어 (한국어/영어 둘 다 지원)
    if (message.content.startsWith('!시세 ')) {
        const itemName = message.content.slice(4).trim();
        
        if (!itemName) {
            return message.reply('아이템 이름을 입력해주세요.\n예: `!시세 염료: 순백색` 또는 `!시세 Pure White`');
        }
        
        const searchMsg = await message.reply(`🔍 **${itemName}** 검색 중...`);
        
        try {
            let item = null;
            let iconUrl = null;
            let suggestions = [];
            
            // 1. 한국어 DB에서 먼저 검색
            if (koreanItemDB.size > 0) {
                const result = searchKoreanItem(itemName);
                item = result.item;
                suggestions = result.suggestions;
                
                if (item && item.icon) {
                    iconUrl = `https://xivapi.com${item.icon}`;
                }
            }
            
            // 2. 한국어 DB에 없으면 XIVAPI로 영어 검색
            if (!item) {
                const enItem = await searchItemByNameEN(itemName);
                if (enItem) {
                    item = enItem;
                    if (enItem.icon) {
                        iconUrl = `https://xivapi.com${enItem.icon}`;
                    }
                }
            }
            
            if (!item) {
                return searchMsg.edit(`**${itemName}**을(를) 찾을 수 없습니다.\n\n`);
            }
            
            await searchMsg.edit(`🔍 **${item.name}** 시세 조회 중...`);
            
            // 3. 모든 한국 서버 시세 조회
            const data = await getAllKoreanServerPrices(item.id);
            
            // 4. 결과 임베드 생성 및 전송
            const embed = createResultEmbed(item.name, item.id, data, iconUrl);
            
            // 5. 추천 목록 추가 (최대 5개, footer로 작은 폰트)
            if (suggestions.length > 0) {
                const suggestionList = suggestions
                    .slice(0, 5)
                    .map(s => s.name)
                    .join(' • ');
                embed.setFooter({ text: `다른 아이템을 찾으셨나요? ${suggestionList}` });
            }
            
            await searchMsg.edit({ content: null, embeds: [embed] });
            
        } catch (error) {
            console.error('시세 조회 오류:', error);
            await searchMsg.edit(`오류가 발생했습니다: ${error.message}`);
        }
    }
    
    // !시세id [아이템ID] 명령어 - ID로 직접 검색
    if (message.content.startsWith('!시세id ')) {
        const itemIdStr = message.content.slice(7).trim();
        const itemId = parseInt(itemIdStr, 10);
        
        if (isNaN(itemId) || itemId <= 0) {
            return message.reply('올바른 아이템 ID를 입력해주세요. 예: `!시세id 17534`');
        }
        
        const searchMsg = await message.reply(`🔍 아이템 ID **${itemId}** 시세 조회 중...`);
        
        try {
            // 한국어 DB에서 아이템 이름 찾기
            let itemName = `아이템 #${itemId}`;
            let iconUrl = null;
            
            for (const [name, item] of koreanItemDB) {
                if (item.id === itemId) {
                    itemName = item.name;
                    if (item.icon) {
                        iconUrl = `https://xivapi.com${item.icon}`;
                    }
                    break;
                }
            }
            
            const data = await getAllKoreanServerPrices(itemId);
            const embed = createResultEmbed(itemName, itemId, data, iconUrl);
            await searchMsg.edit({ content: null, embeds: [embed] });
        } catch (error) {
            console.error('시세 조회 오류:', error);
            await searchMsg.edit(`오류가 발생했습니다: ${error.message}`);
        }
    }
    
    // !시세도움 명령어
    if (message.content === '!시세도움' || message.content === '!시세help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('📖 파판14 시세 봇 사용법')
            .setDescription('한국 서버(카벙클, 초코보, 모그리, 톤베리, 펜리르)의 장터 시세를 조회합니다.')
            .addFields(
                { name: '!시세 [아이템이름]', value: '아이템 이름으로 검색\n예: `!시세 염료: 순백색`' },
                { name: '!시세id [아이템ID]', value: '아이템 ID로 직접 검색\n예: `!시세id 17534`' },
                { name: '!시세도움', value: '이 도움말 표시' }
            )
            .setFooter({ text: 'Powered by Universalis API' });
        
        return message.reply({ embeds: [helpEmbed] });
    }
});

client.login(process.env.DISCORD_TOKEN);