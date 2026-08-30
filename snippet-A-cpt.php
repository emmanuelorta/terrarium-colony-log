add_action('init', function () {
	register_post_type('sv_colony', array(
		'label'           => 'Colonies',
		'public'          => false,
		'show_ui'         => false,
		'show_in_rest'    => true,
		'rest_base'       => 'colonies',
		'supports'        => array('title', 'custom-fields'),
		'capability_type' => 'post',
		'map_meta_cap'    => true,
		'exclude_from_search' => true,
	));
	register_post_meta('sv_colony', 'svc_data', array(
		'show_in_rest' => true,
		'single'       => true,
		'type'         => 'string',
		'auth_callback' => function () { return current_user_can('edit_posts'); },
		'sanitize_callback' => function ($v) { return is_string($v) ? $v : ''; },
	));
}, 5);
