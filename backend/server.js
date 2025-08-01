const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

// 导入数据库
const { sequelize } = require('./models');

// 导入路由
const authRoutes = require('./routes/auth');
const torrentRoutes = require('./routes/torrents');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const trackerRoutes = require('./routes/tracker');
const statsRoutes = require('./routes/stats');

// 导入统计调度器
const statsScheduler = require('./utils/statsScheduler');

const app = express();
const PORT = process.env.PORT || 3001;

// 信任代理 (用于获取客户端真实IP)
app.set('trust proxy', true);

// 中间件
app.use(helmet({
  contentSecurityPolicy: false // 暂时禁用CSP进行调试
}));
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静态文件服务 - 添加CORS头
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// 数据库连接测试中间件
app.use(async (req, res, next) => {
  try {
    await sequelize.authenticate();
    next();
  } catch (error) {
    console.error('数据库连接失败:', error);
    res.status(503).json({ 
      error: '数据库服务不可用',
      message: '请联系管理员检查数据库连接'
    });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'PT站服务正常运行',
    timestamp: new Date().toISOString(),
    tracker: 'enabled'
  });
});

// API健康检查路由
app.get('/api/health', async (req, res) => {
  try {
    // 测试数据库连接
    await sequelize.authenticate();
    
    // 获取一些基本统计信息
    const { User, Category, Torrent, Download } = require('./models');
    const stats = {
      users: await User.count(),
      categories: await Category.count(),
      torrents: await Torrent.count(),
      downloads: await Download.count()
    };
    
    res.json({ 
      status: 'OK', 
      message: 'PT站API服务正常运行（数据库模式）',
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        dialect: sequelize.getDialect(),
        stats
      },
      tracker: {
        enabled: true,
        announceUrl: process.env.ANNOUNCE_URL || `http://localhost:${PORT}/announce`
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      message: '服务不可用',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 种子发布页面的基本信息
app.get('/api/upload/info', async (req, res) => {
  try {
    const { Category } = require('./models');
    const categories = await Category.findAll({
      attributes: ['id', 'name', 'description'],
      order: [['name', 'ASC']]
    });
    
    res.json({
      categories,
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 100000000,
      allowedTypes: ['.torrent'],
      announceUrl: process.env.ANNOUNCE_URL || `http://localhost:${PORT}/announce`
    });
  } catch (error) {
    console.error('获取上传信息失败:', error);
    res.status(500).json({ error: '获取上传信息失败' });
  }
});

// 站点统计端点
app.get('/api/stats', async (req, res) => {
  try {
    const { User, Torrent, UserStats, Category, Download } = require('./models');
    
    const [
      totalUsers,
      totalTorrents,
      approvedTorrents,
      totalCategories,
      totalDownloads
    ] = await Promise.all([
      User.count(),
      Torrent.count(),
      Torrent.count({ where: { status: 'approved' } }),
      Category.count(),
      Download.count()
    ]);

    // 计算总上传和下载量
    const stats = await UserStats.findAll({
      attributes: [
        [sequelize.fn('sum', sequelize.col('uploaded')), 'totalUploaded'],
        [sequelize.fn('sum', sequelize.col('downloaded')), 'totalDownloaded']
      ]
    });

    res.json({
      stats: {
        total_users: totalUsers,
        active_users: totalUsers, // 不再区分活跃用户，直接使用总用户数
        total_torrents: totalTorrents,
        approved_torrents: approvedTorrents,
        pending_torrents: totalTorrents - approvedTorrents,
        total_categories: totalCategories,
        total_downloads: totalDownloads,
        tracker_enabled: true
      },
      traffic: {
        totalUploaded: parseInt(stats[0]?.dataValues?.totalUploaded || 0),
        totalDownloaded: parseInt(stats[0]?.dataValues?.totalDownloaded || 0)
      }
    });
  } catch (error) {
    console.error('获取统计信息失败:', error);
    res.status(500).json({ error: '获取统计信息失败' });
  }
});

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/torrents', torrentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/stats', statsRoutes);

// Tracker 路由 (放在最后，避免拦截其他路由)
app.use('/', trackerRoutes);

// 404处理
app.use((req, res) => {
  res.status(404).json({ 
    error: '请求的资源不存在',
    path: req.path,
    method: req.method
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.stack);
  
  // Sequelize错误处理
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      error: '数据验证失败',
      details: err.errors.map(e => ({ field: e.path, message: e.message }))
    });
  }
  
  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      error: '数据冲突',
      message: '该记录已存在'
    });
  }
  
  res.status(500).json({ 
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : '请联系管理员',
    timestamp: new Date().toISOString()
  });
});

// 数据库连接和服务器启动
async function startServer() {
  try {
    // 连接数据库
    await sequelize.authenticate();
    console.log('✅ 数据库连接成功');
    
    // 同步数据库表 (开发环境)
    if (process.env.NODE_ENV === 'development') {
      await sequelize.sync({ alter: true });
      console.log('✅ 数据库表同步完成');
      
      // 初始化用户 passkey
      await initializeUserPasskeys();
    } else {
      // 生产环境使用更安全的同步
      await sequelize.sync({ alter: false });
      console.log('✅ 数据库同步完成');
    }
    
    // 启动服务器
    app.listen(PORT, () => {
      console.log(`🚀 PT站服务器运行在 http://localhost:${PORT}`);
      console.log(`📡 Tracker服务: http://localhost:${PORT}/announce`);
      console.log(`🔧 API端点: http://localhost:${PORT}/api`);
      console.log(`📊 统计信息: http://localhost:${PORT}/api/stats`);
      console.log(`💊 健康检查: http://localhost:${PORT}/api/health`);
      console.log(`🗄️  数据库: ${sequelize.getDatabaseName()} (${sequelize.getDialect()})`);
      console.log(`🌍 环境: ${process.env.NODE_ENV || 'development'}`);
      
      // 启动统计调度器
      if (process.env.NODE_ENV !== 'test') {
        setTimeout(() => {
          statsScheduler.start();
        }, 5000); // 延迟5秒启动，确保数据库连接稳定
      }
    });
    
  } catch (error) {
    console.error('❌ 服务器启动失败:', error);
    process.exit(1);
  }
}

// 初始化现有用户的 passkey
async function initializeUserPasskeys() {
  try {
    const { User, UserPasskey } = require('./models');
    const { generatePasskey } = require('./utils/passkey');
    
    const users = await User.findAll();
    
    for (const user of users) {
      const existingPasskey = await UserPasskey.findOne({
        where: { user_id: user.id }
      });
      
      if (!existingPasskey) {
        await UserPasskey.create({
          user_id: user.id,
          passkey: generatePasskey(),
          active: true
        });
        console.log(`✅ 为用户 ${user.username} 创建 passkey`);
      }
    }
  } catch (error) {
    console.error('初始化 passkey 失败:', error);
  }
}

// 优雅关闭处理
process.on('SIGINT', async () => {
  console.log('\n🛑 正在关闭服务器...');
  try {
    // 停止统计调度器
    statsScheduler.stop();
    
    await sequelize.close();
    console.log('✅ 数据库连接已关闭');
    process.exit(0);
  } catch (error) {
    console.error('❌ 关闭过程中出现错误:', error);
    process.exit(1);
  }
});

// 启动服务器
startServer();

module.exports = app;
